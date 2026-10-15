use crate::{
    api::models::{ApiResponse, HistoryItem, ScanRequest, ScanResponse, ScanStatusResponse},
    db::schema::{
        get_scan as db_get_scan, list_scans, create_running_scan, complete_scan, fail_scan,
        get_running_scans, delete_scan, get_scan_children, get_entry_by_path, Scan, ScanEntry,
    },
    scanner::{
        resolve_scan_roots, CancelToken, FileNode, ScanRequest as ScannerRequest, Scanner,
    },
};
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{error, info};
use chrono::Utc;
use serde_json;

use super::AppState;

#[derive(Debug, Deserialize)]
pub struct TreeParams {
    #[serde(default = "default_depth")]
    pub depth: usize,
    #[serde(default = "default_max_children")]
    pub max_children: usize,
}

#[derive(Debug, Deserialize)]
pub struct NodeParams {
    pub path: String,
    #[serde(default = "default_depth")]
    pub depth: usize,
    #[serde(default = "default_max_children")]
    pub max_children: usize,
}

fn default_depth() -> usize {
    2
}

fn default_max_children() -> usize {
    50
}

/// Hard caps so clients cannot request unbounded trees (causes gateway 524s).
const MAX_TREE_DEPTH: usize = 4;
const MAX_TREE_CHILDREN: usize = 200;

fn clamp_tree_params(depth: usize, max_children: usize) -> (usize, usize) {
    (
        depth.clamp(1, MAX_TREE_DEPTH),
        max_children.clamp(1, MAX_TREE_CHILDREN),
    )
}

pub async fn start_scan(
    State(state): State<Arc<Mutex<AppState>>>,
    Json(payload): Json<ScanRequest>,
) -> Json<ApiResponse<ScanResponse>> {
    // Path takes priority over whole-disk mounts when both are provided.
    // Disks alone still map to their primary mountpoints. list_disks is
    // blocking (/proc, statvfs) so run off the async runtime.
    let path = payload.path.clone();
    let disks = payload.disks.clone();
    let paths_to_scan = match tokio::task::spawn_blocking(move || resolve_scan_roots(&path, &disks))
        .await
    {
        Ok(Ok(paths)) => paths,
        Ok(Err(e)) => return Json(ApiResponse::error(e)),
        Err(e) => {
            return Json(ApiResponse::error(format!("Failed to resolve scan roots: {e}")));
        }
    };

    let effective_path = paths_to_scan
        .first()
        .cloned()
        .unwrap_or_else(|| payload.path.clone());

    info!(
        "Starting streaming scan of: {} (disks={:?}, roots={:?}, same_filesystem={})",
        effective_path, payload.disks, paths_to_scan, payload.same_filesystem
    );

    let scan_id = uuid::Uuid::new_v4().to_string();
    let db_path = {
        let state = state.lock().await;
        state.db_path.clone()
    };

    let disks_json = serde_json::to_string(&payload.disks).unwrap_or_else(|_| "[]".to_string());

    {
        let db = {
            let state = state.lock().await;
            state.db.clone()
        };
        let conn = db.lock().await;
        if let Err(e) = create_running_scan(&conn, &scan_id, &effective_path, &disks_json) {
            error!("Failed to create running scan record: {}", e);
            return Json(ApiResponse::error(format!("Failed to start scan: {e}")));
        }
    }

    let cancel: CancelToken = Arc::new(AtomicBool::new(false));
    {
        let state = state.lock().await;
        state.running_scans.lock().await.insert(scan_id.clone(), cancel.clone());
    }

    let request = ScannerRequest {
        id: scan_id.clone(),
        path: effective_path.clone(),
        paths: paths_to_scan.clone(),
        max_depth: payload.max_depth,
        follow_symlinks: payload.follow_symlinks,
        same_filesystem: payload.same_filesystem,
    };

    // Spawn the scan as a background task so the HTTP response returns
    // immediately with the scan ID. The frontend polls /api/scan/:id/status
    // for progress updates instead of waiting for this request to complete.
    let state_clone = state.clone();
    let scan_id_for_task = scan_id.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            Scanner::scan_to_db(request, &db_path, None, Some(cancel))
        })
        .await;

        let db = {
            let state = state_clone.lock().await;
            state.db.clone()
        };

        match result {
            Ok(Ok(r)) => {
                let conn = db.lock().await;
                if let Err(e) = complete_scan(
                    &conn,
                    &r.id,
                    r.total_size,
                    r.total_files,
                    r.total_dirs,
                    r.scan_time_ms,
                    None,
                ) {
                    error!("Failed to complete scan in DB: {}", e);
                }
                info!("Background scan complete: {} - {} files", r.id, r.total_files);
            }
            Ok(Err(e)) => {
                let conn = db.lock().await;
                let _ = fail_scan(&conn, &scan_id_for_task, &format!("Scan error: {e}"));
                error!("Background scan failed: {} - {}", scan_id_for_task, e);
            }
            Err(e) => {
                let conn = db.lock().await;
                let _ = fail_scan(&conn, &scan_id_for_task, &format!("Task error: {e}"));
                error!("Background scan task panicked: {} - {}", scan_id_for_task, e);
            }
        }

        {
            let state = state_clone.lock().await;
            state.running_scans.lock().await.remove(&scan_id_for_task);
        }
    });

    let response = ScanResponse {
        id: scan_id.clone(),
        path: effective_path,
        roots: paths_to_scan,
        disks: payload.disks,
        same_filesystem: payload.same_filesystem,
        total_size: 0,
        total_files: 0,
        total_dirs: 0,
        scan_time_ms: 0,
        created_at: Utc::now().to_rfc3339(),
    };

    info!("Scan {} started in background", scan_id);
    Json(ApiResponse::success(response))
}

pub async fn list_disks_handler() -> Json<ApiResponse<Vec<crate::scanner::DiskInfo>>> {
    let disks = tokio::task::spawn_blocking(crate::scanner::list_disks)
        .await
        .unwrap_or_default();
    Json(ApiResponse::success(disks))
}

pub async fn get_scan(
    State(state): State<Arc<Mutex<AppState>>>,
    Path(scan_id): Path<String>,
) -> Json<ApiResponse<Scan>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match db_get_scan(&conn, &scan_id) {
        Ok(Some(scan)) => Json(ApiResponse::success(scan)),
        Ok(None) => Json(ApiResponse::error("Scan not found")),
        Err(e) => Json(ApiResponse::error(format!("Database error: {e}"))),
    }
}

/// Build a FileNode tree from the database incrementally, fetching only the
/// children needed up to `depth` levels. This avoids loading the entire scan
/// (which could be millions of rows) into memory per request.
fn build_tree_from_db(
    conn: &rusqlite::Connection,
    scan_id: &str,
    root_path: &str,
    depth: usize,
    max_children: usize,
) -> Result<FileNode, String> {
    let mut root = FileNode::new_dir(std::path::PathBuf::from(root_path));
    if let Ok(Some(root_entry)) = get_entry_by_path(conn, scan_id, root_path) {
        root.size = root_entry.size as u64;
    }
    if depth == 0 {
        return Ok(root);
    }
    root.children = Some(fetch_children_recursive(
        conn,
        scan_id,
        root_path,
        depth,
        max_children,
    )?);
    Ok(root)
}

/// Recursively fetch children of `parent_path` from the DB, applying the
/// `max_children` limit per node (overflowing into a synthetic "Others" node)
/// and stopping recursion at `remaining_depth` levels.
fn fetch_children_recursive(
    conn: &rusqlite::Connection,
    scan_id: &str,
    parent_path: &str,
    remaining_depth: usize,
    max_children: usize,
) -> Result<Vec<FileNode>, String> {
    let page = get_scan_children(conn, scan_id, parent_path, max_children)
        .map_err(|e| format!("DB error: {e}"))?;

    let mut children: Vec<FileNode> = Vec::with_capacity(page.entries.len() + 1);

    for entry in &page.entries {
        let mut node = scan_entry_to_file_node(entry);
        if entry.is_dir && remaining_depth > 1 {
            node.children = Some(fetch_children_recursive(
                conn,
                scan_id,
                &entry.path,
                remaining_depth - 1,
                max_children,
            )?);
        }
        children.push(node);
    }

    if page.others_size > 0 || page.others_count > 0 {
        children.push(FileNode {
            path: std::path::PathBuf::from(format!("{parent_path}__others__")),
            name: "Others".to_string(),
            size: page.others_size,
            is_dir: true,
            children: None,
            file_count: Some(page.others_count),
            modified: None,
        });
    }

    Ok(children)
}

fn scan_entry_to_file_node(entry: &ScanEntry) -> FileNode {
    if entry.is_dir {
        let mut n = FileNode::new_dir(std::path::PathBuf::from(&entry.path));
        n.size = entry.size as u64;
        n
    } else {
        FileNode::new_file(
            std::path::PathBuf::from(&entry.path),
            entry.size as u64,
            entry.modified,
        )
    }
}

pub async fn get_scan_tree(
    State(state): State<Arc<Mutex<AppState>>>,
    Path(scan_id): Path<String>,
    Query(params): Query<TreeParams>,
) -> Json<ApiResponse<FileNode>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };

    let scan_id_owned = scan_id.clone();
    let (depth, max_children) = clamp_tree_params(params.depth, params.max_children);
    let db_clone = db.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<FileNode, String> {
        let conn = db_clone.blocking_lock();
        let root_path = match db_get_scan(&conn, &scan_id_owned) {
            Ok(Some(scan)) => scan.path,
            Ok(None) => return Err("Scan not found".to_string()),
            Err(e) => return Err(format!("Database error: {e}")),
        };
        build_tree_from_db(&conn, &scan_id_owned, &root_path, depth, max_children)
    })
    .await;

    match result {
        Ok(Ok(tree)) => Json(ApiResponse::success(tree)),
        Ok(Err(e)) => Json(ApiResponse::error(e)),
        Err(e) => Json(ApiResponse::error(format!("Task error: {e}"))),
    }
}

pub async fn get_scan_node(
    State(state): State<Arc<Mutex<AppState>>>,
    Path(scan_id): Path<String>,
    Query(params): Query<NodeParams>,
) -> Json<ApiResponse<FileNode>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };

    let scan_id_owned = scan_id.clone();
    let path_owned = params.path.clone();
    let (depth, max_children) = clamp_tree_params(params.depth, params.max_children);
    let db_clone = db.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<FileNode, String> {
        let conn = db_clone.blocking_lock();
        let entry = match get_entry_by_path(&conn, &scan_id_owned, &path_owned) {
            Ok(Some(e)) => e,
            Ok(None) => return Err(format!("Node not found: {path_owned}")),
            Err(e) => return Err(format!("Database error: {e}")),
        };
        let mut node = scan_entry_to_file_node(&entry);
        if entry.is_dir && depth > 0 {
            node.children = Some(fetch_children_recursive(
                &conn,
                &scan_id_owned,
                &entry.path,
                depth,
                max_children,
            )?);
        } else if entry.is_dir {
            node.children = None;
        }
        Ok(node)
    })
    .await;

    match result {
        Ok(Ok(node)) => Json(ApiResponse::success(node)),
        Ok(Err(e)) => Json(ApiResponse::error(e)),
        Err(e) => Json(ApiResponse::error(format!("Task error: {e}"))),
    }
}

pub async fn list_history(
    State(state): State<Arc<Mutex<AppState>>>,
) -> Json<ApiResponse<Vec<HistoryItem>>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match list_scans(&conn, 50) {
        Ok(scans) => {
            let items: Vec<HistoryItem> = scans
                .into_iter()
                .map(|s| {
                    let is_running = s.status == "running";
                    HistoryItem {
                        id: s.id,
                        path: s.path,
                        disks: s.disks,
                        status: s.status,
                        total_size: s.total_size,
                        total_files: s.total_files,
                        total_dirs: s.total_dirs,
                        progress_files: if is_running { Some(s.progress_files) } else { None },
                        progress_dirs: if is_running { Some(s.progress_dirs) } else { None },
                        progress_size: if is_running { Some(s.progress_size) } else { None },
                        current_path: s.current_path,
                        scan_time_ms: s.scan_time_ms,
                        error_message: s.error_message,
                        created_at: s.created_at,
                    }
                })
                .collect();
            Json(ApiResponse::success(items))
        }
        Err(e) => Json(ApiResponse::error(format!("Database error: {e}"))),
    }
}

pub async fn get_scan_status(
    State(state): State<Arc<Mutex<AppState>>>,
    Path(scan_id): Path<String>,
) -> Json<ApiResponse<ScanStatusResponse>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match db_get_scan(&conn, &scan_id) {
        Ok(Some(scan)) => {
            let is_completed = scan.status == "completed";
            let response = ScanStatusResponse {
                id: scan.id,
                path: scan.path,
                status: scan.status,
                progress_files: scan.progress_files,
                progress_dirs: scan.progress_dirs,
                progress_size: scan.progress_size,
                current_path: scan.current_path,
                total_files: if is_completed { Some(scan.total_files) } else { None },
                total_dirs: if is_completed { Some(scan.total_dirs) } else { None },
                error_message: scan.error_message,
            };
            Json(ApiResponse::success(response))
        }
        Ok(None) => Json(ApiResponse::error("Scan not found")),
        Err(e) => Json(ApiResponse::error(format!("Database error: {e}"))),
    }
}

pub async fn list_running_scans(
    State(state): State<Arc<Mutex<AppState>>>,
) -> Json<ApiResponse<Vec<ScanStatusResponse>>> {
    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match get_running_scans(&conn) {
        Ok(scans) => {
            let items: Vec<ScanStatusResponse> = scans
                .into_iter()
            .map(|s| ScanStatusResponse {
                id: s.id,
                path: s.path,
                status: s.status,
                progress_files: s.progress_files,
                progress_dirs: s.progress_dirs,
                progress_size: s.progress_size,
                current_path: s.current_path,
                total_files: None,
                total_dirs: None,
                error_message: s.error_message,
            })
                .collect();
            Json(ApiResponse::success(items))
        }
        Err(e) => Json(ApiResponse::error(format!("Database error: {e}"))),
    }
}

pub async fn delete_scan_handler(
    State(state): State<Arc<Mutex<AppState>>>,
    Path(scan_id): Path<String>,
) -> Json<ApiResponse<()>> {
    let was_running = {
        let state = state.lock().await;
        let running = state.running_scans.lock().await;
        if let Some(token) = running.get(&scan_id) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    };
    if was_running {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    let tree_dir = {
        let state = state.lock().await;
        state.tree_dir.clone()
    };
    let tree_path = tree_dir.join(format!("{scan_id}.json"));
    let _ = tokio::fs::remove_file(&tree_path).await;

    let db = {
        let state = state.lock().await;
        state.db.clone()
    };
    let conn = db.lock().await;

    match delete_scan(&conn, &scan_id) {
        Ok(true) => {
            let state = state.lock().await;
            state.running_scans.lock().await.remove(&scan_id);
            info!("Deleted scan: {}", scan_id);
            Json(ApiResponse::success(()))
        }
        Ok(false) => {
            let state = state.lock().await;
            state.running_scans.lock().await.remove(&scan_id);
            Json(ApiResponse::error("Scan not found"))
        }
        Err(e) => Json(ApiResponse::error(format!("Database error: {e}"))),
    }
}

#[derive(Debug, Serialize)]
pub struct EasterEgg {
    pub question: String,
    pub answer: String,
}

pub async fn easter_egg() -> Json<ApiResponse<EasterEgg>> {
    Json(ApiResponse::success(EasterEgg {
        question: "Dude, where are my bytes?".to_string(),
        answer: "They're in node_modules.".to_string(),
    }))
}
