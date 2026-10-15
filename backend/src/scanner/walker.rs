use crate::scanner::types::{ProgressCallback, ScanRequest, ScanResult, ScanProgress};
use crate::db::schema::{calculate_dir_sizes, count_scan_entries, update_scan_progress};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};
use walkdir::WalkDir;

pub struct Scanner;

/// A cooperative cancellation flag for a running scan. The scanner checks it
/// inside its walk loop and exits early when set, allowing running scans to be
/// aborted (e.g. via the DELETE endpoint).
pub type CancelToken = Arc<AtomicBool>;

#[derive(Debug, Default)]
struct ScanStats {
    files: u64,
    dirs: u64,
    total_size: u64,
}

impl Scanner {
    pub fn scan_to_db(
        request: ScanRequest,
        db_path: &Path,
        progress_cb: Option<Arc<ProgressCallback>>,
        cancel: Option<CancelToken>,
    ) -> Result<ScanResult, String> {
        let start = Instant::now();

        let paths_to_scan: Vec<String> = if !request.paths.is_empty() {
            request.paths.clone()
        } else {
            vec![request.path.clone()]
        };

        for p in &paths_to_scan {
            let root = Path::new(p);
            if !root.exists() {
                return Err(format!("Path does not exist: {p}"));
            }
            if !root.is_dir() {
                return Err(format!("Path is not a directory: {p}"));
            }
        }

        info!(
            "Starting streaming scan of: {:?} ({} roots)",
            paths_to_scan,
            paths_to_scan.len()
        );

        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open DB: {e}"))?;
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        let _ = conn.pragma_update(None, "busy_timeout", 10000);

        let mut stats = ScanStats::default();
        let scan_id = request.id.clone();

        // --- Stall detection watchdog ---
        // A separate thread monitors progress. If no entries are processed for
        // 30+ seconds (e.g. a hung filesystem operation), it logs a warning
        // with the last known path so the user can see where the scan is stuck.
        let progress_counter = Arc::new(AtomicU64::new(0));
        let stall_path: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let watchdog_done = Arc::new(AtomicBool::new(false));

        let watchdog = {
            let wc = progress_counter.clone();
            let wp = stall_path.clone();
            let wd = watchdog_done.clone();
            let wsid = scan_id.clone();
            let wcancel = cancel.clone();
            thread::spawn(move || {
                let mut last_count: u64 = 0;
                let mut last_change = Instant::now();
                loop {
                    thread::sleep(Duration::from_secs(10));
                    if wd.load(Ordering::SeqCst) {
                        break;
                    }
                    if let Some(token) = &wcancel {
                        if token.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    let current_count = wc.load(Ordering::Relaxed);
                    if current_count == last_count {
                        let stalled_for = last_change.elapsed();
                        if stalled_for >= Duration::from_secs(30) {
                            let path = wp.lock().unwrap().clone();
                            warn!(
                                "Scan {} STALLED for {:?} — no progress in this period. \
                                 Last path: {}",
                                wsid, stalled_for, path
                            );
                        }
                    } else {
                        last_count = current_count;
                        last_change = Instant::now();
                    }
                }
            })
        };

        const BATCH_SIZE: usize = 2000;
        const LOG_INTERVAL: Duration = Duration::from_secs(10);

        conn.execute_batch("BEGIN")
            .map_err(|e| format!("Failed to begin transaction: {e}"))?;

        let mut last_log = Instant::now();
        let mut last_log_files: u64 = 0;
        let mut last_log_dirs: u64 = 0;
        let mut insert_errors: u64 = 0;

        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO scan_entries (scan_id, path, name, parent_path, size, is_dir, modified) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|e| format!("Failed to prepare insert: {e}"))?;

            let mut batch_count = 0usize;

            // Walk each root in sequence. When paths is empty the caller fills
            // paths_to_scan with [request.path], so single-path behavior is unchanged.
            'roots: for scan_root_str in &paths_to_scan {
                let current_root = Path::new(scan_root_str);

                let mut walker_builder =
                    WalkDir::new(current_root)
                        .follow_links(request.follow_symlinks)
                        .same_file_system(request.same_filesystem);

                if let Some(max_depth) = request.max_depth {
                    walker_builder = walker_builder.max_depth(max_depth);
                }

                let walker = walker_builder.into_iter();

                for entry in walker {
                if let Some(token) = &cancel {
                    if token.load(Ordering::SeqCst) {
                        info!("Scan {} cancelled by request", scan_id);
                        break 'roots;
                    }
                }

                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        warn!("WalkDir error in scan {}: {}", scan_id, e);
                        continue;
                    }
                };

                let entry_path = entry.path();
                let path_str = entry_path.to_string_lossy().to_string();

                {
                    let mut p = stall_path.lock().unwrap();
                    *p = path_str.clone();
                }

                let is_dir = entry.file_type().is_dir();
                let size = if is_dir {
                    0
                } else {
                    entry.metadata().map(|m| m.len()).unwrap_or(0)
                };
                let modified = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);

                let name = entry_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let parent_path = if entry_path == current_root {
                    String::new()
                } else {
                    entry_path
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default()
                };

                match stmt.execute(params![
                    &scan_id,
                    &path_str,
                    &name,
                    &parent_path,
                    size as i64,
                    is_dir,
                    modified,
                ]) {
                    Ok(_) => {}
                    Err(e) => {
                        insert_errors += 1;
                        if insert_errors <= 10 || insert_errors.is_multiple_of(1000) {
                            warn!(
                                "INSERT error #{} in scan {}: {} (path: {})",
                                insert_errors, scan_id, e, path_str
                            );
                        }
                        continue;
                    }
                }

                if is_dir {
                    stats.dirs += 1;
                } else {
                    stats.files += 1;
                    stats.total_size += size;
                }

                batch_count += 1;
                progress_counter.store(batch_count as u64, Ordering::Relaxed);

                if batch_count.is_multiple_of(BATCH_SIZE) {
                    if let Err(e) = update_scan_progress(
                        &conn,
                        &scan_id,
                        stats.files,
                        stats.dirs,
                        stats.total_size,
                        &path_str,
                    ) {
                        warn!("Failed to update progress for scan {}: {}", scan_id, e);
                    }

                    conn.execute_batch("COMMIT")
                        .map_err(|e| format!("Failed to commit batch: {e}"))?;
                    conn.execute_batch("BEGIN")
                        .map_err(|e| format!("Failed to begin batch: {e}"))?;
                }

                if last_log.elapsed() >= LOG_INTERVAL {
                    let elapsed = last_log.elapsed();
                    let d_files = stats.files.saturating_sub(last_log_files);
                    let d_dirs = stats.dirs.saturating_sub(last_log_dirs);
                    let total = d_files + d_dirs;
                    let rate = if elapsed.as_secs_f64() > 0.0 {
                        (total as f64 / elapsed.as_secs_f64()) as u64
                    } else {
                        0
                    };
                    let total_size_mb = stats.total_size / (1024 * 1024);
                    info!(
                        "Scan {} progress: {} files, {} dirs, {} MB scanned; {} entries/s; current: {}",
                        scan_id, stats.files, stats.dirs, total_size_mb, rate, path_str
                    );
                    last_log = Instant::now();
                    last_log_files = stats.files;
                    last_log_dirs = stats.dirs;
                }

                if let Some(cb) = &progress_cb {
                    let progress = ScanProgress {
                        scanned_files: stats.files,
                        scanned_dirs: stats.dirs,
                        current_path: path_str,
                        is_complete: false,
                    };
                    cb(&progress);
                }
                }
            }
        }

        conn.execute_batch("COMMIT")
            .map_err(|e| format!("Failed to commit transaction: {e}"))?;

        // Stop the watchdog
        watchdog_done.store(true, Ordering::SeqCst);
        let _ = watchdog.join();

        if let Some(token) = &cancel {
            if token.load(Ordering::SeqCst) {
                return Err("Scan cancelled".to_string());
            }
        }

        if insert_errors > 0 {
            warn!(
                "Scan {} completed with {} total INSERT errors",
                scan_id, insert_errors
            );
        }

        // Final progress update before the potentially long dir-size pass so
        // the UI shows we left the walk phase.
        if let Err(e) = update_scan_progress(
            &conn,
            &scan_id,
            stats.files,
            stats.dirs,
            stats.total_size,
            "calculating directory sizes…",
        ) {
            warn!("Failed to update pre-aggregate progress for scan {}: {}", scan_id, e);
        }

        info!(
            "Scan {} walk done ({} files, {} dirs). Calculating directory sizes…",
            scan_id, stats.files, stats.dirs
        );
        debug!("Calculating directory sizes for scan {}", scan_id);
        if let Err(e) = calculate_dir_sizes(&conn, &scan_id) {
            warn!("Failed to calculate dir sizes: {}", e);
        }

        let (files, dirs) = count_scan_entries(&conn, &scan_id).unwrap_or((0, 0));

        let elapsed = start.elapsed();

        if let Some(cb) = &progress_cb {
            let progress = ScanProgress {
                scanned_files: stats.files,
                scanned_dirs: stats.dirs,
                current_path: String::new(),
                is_complete: true,
            };
            cb(&progress);
        }

        info!(
            "Streaming scan complete: {} files, {} dirs in {:?}",
            files, dirs, elapsed
        );

        Ok(ScanResult {
            id: request.id,
            path: request.path,
            total_size: stats.total_size,
            total_files: files as u64,
            total_dirs: dirs as u64,
            root: None,
            scan_time_ms: elapsed.as_millis() as u64,
            created_at: Utc::now().to_rfc3339(),
        })
    }
}
