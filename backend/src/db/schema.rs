use rusqlite::{params, Connection, Result};
use std::path::Path;
use tracing::{debug, info};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    disks TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    total_size INTEGER NOT NULL DEFAULT 0,
    total_files INTEGER NOT NULL DEFAULT 0,
    total_dirs INTEGER NOT NULL DEFAULT 0,
    progress_files INTEGER NOT NULL DEFAULT 0,
    progress_dirs INTEGER NOT NULL DEFAULT 0,
    progress_size INTEGER NOT NULL DEFAULT 0,
    current_path TEXT,
    scan_time_ms INTEGER NOT NULL DEFAULT 0,
    root_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS scan_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    is_dir BOOLEAN NOT NULL,
    modified INTEGER,
    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_entries_scan ON scan_entries(scan_id);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON scan_entries(scan_id, parent_path);
CREATE INDEX IF NOT EXISTS idx_entries_path ON scan_entries(scan_id, path);
CREATE INDEX IF NOT EXISTS idx_entries_parent_size ON scan_entries(scan_id, parent_path, is_dir DESC, size DESC);
"#;

pub fn init_db(db_path: &Path) -> Result<Connection> {
    info!("Initializing database at: {:?}", db_path);

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let conn = Connection::open(db_path)?;
    conn.execute_batch(SCHEMA)?;

    // Enable WAL so concurrent reads (history/status polls) don't block on the
    // scanner's batched write transaction during a long running scan.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    // Enforce foreign keys so ON DELETE CASCADE removes scan_entries when a
    // scan is deleted, and wait (up to 10s) for a busy writer instead of
    // erroring immediately when the scanner holds the write lock.
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    let _ = conn.pragma_update(None, "busy_timeout", 10000);

    // Idempotent migration: add progress_size column to pre-existing databases.
    // CREATE TABLE IF NOT EXISTS won't add new columns to an existing table, so
    // we check the live schema and ALTER if missing.
    let has_progress_size: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(scans)")?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        names.iter().any(|name| name == "progress_size")
    };
    if !has_progress_size {
        conn.execute_batch(
            "ALTER TABLE scans ADD COLUMN progress_size INTEGER NOT NULL DEFAULT 0",
        )?;
        info!("Migrated scans table: added progress_size column");
    }

    // Idempotent migration: add disks column to pre-existing databases.
    let has_disks: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(scans)")?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();
        names.iter().any(|name| name == "disks")
    };
    if !has_disks {
        conn.execute_batch("ALTER TABLE scans ADD COLUMN disks TEXT NOT NULL DEFAULT '[]'")?;
        info!("Migrated scans table: added disks column");
    }

    info!("Database initialized successfully");
    Ok(conn)
}

pub fn user_exists(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
    Ok(count > 0)
}

pub fn create_user(
    conn: &Connection,
    username: &str,
    password_hash: &str,
    role: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO users (username, password_hash, role) VALUES (?1, ?2, ?3)",
        params![username, password_hash, role],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get_user_by_username(conn: &Connection, username: &str) -> Result<Option<User>> {
    let mut stmt = conn.prepare(
        "SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?1",
    )?;

    let mut rows = stmt.query(params![username])?;

    if let Some(row) = rows.next()? {
        Ok(Some(User {
            id: row.get(0)?,
            username: row.get(1)?,
            password_hash: row.get(2)?,
            role: row.get(3)?,
            created_at: row.get(4)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn create_session(
    conn: &Connection,
    session_id: &str,
    user_id: i64,
    expires_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (id, user_id, expires_at) VALUES (?1, ?2, ?3)",
        params![session_id, user_id, expires_at],
    )?;
    Ok(())
}

pub fn get_session(conn: &Connection, session_id: &str) -> Result<Option<Session>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.user_id, s.expires_at, s.created_at, u.username, u.role 
         FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.id = ?1 AND s.expires_at > datetime('now')",
    )?;

    let mut rows = stmt.query(params![session_id])?;

    if let Some(row) = rows.next()? {
        Ok(Some(Session {
            id: row.get(0)?,
            user_id: row.get(1)?,
            expires_at: row.get(2)?,
            created_at: row.get(3)?,
            username: row.get(4)?,
            role: row.get(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn delete_session(conn: &Connection, session_id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", params![session_id])?;
    Ok(())
}

pub fn delete_expired_sessions(conn: &Connection) -> Result<usize> {
    let deleted = conn.execute(
        "DELETE FROM sessions WHERE expires_at <= datetime('now')",
        [],
    )?;
    Ok(deleted)
}

pub fn create_running_scan(
    conn: &Connection,
    id: &str,
    path: &str,
    disks: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO scans (id, path, disks, status) VALUES (?1, ?2, ?3, 'running')",
        params![id, path, disks]
    )?;
    Ok(())
}

pub fn update_scan_progress(
    conn: &Connection,
    id: &str,
    progress_files: u64,
    progress_dirs: u64,
    progress_size: u64,
    current_path: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE scans SET progress_files = ?1, progress_dirs = ?2, progress_size = ?3, current_path = ?4 WHERE id = ?5",
        params![progress_files as i64, progress_dirs as i64, progress_size as i64, current_path, id]
    )?;
    Ok(())
}

pub fn complete_scan(
    conn: &Connection,
    id: &str,
    total_size: u64,
    total_files: u64,
    total_dirs: u64,
    scan_time_ms: u64,
    root_json: Option<&str>,
) -> Result<()> {
    conn.execute(
        "UPDATE scans SET 
         status = 'completed',
         total_size = ?1,
         total_files = ?2,
         total_dirs = ?3,
         scan_time_ms = ?4,
         root_json = ?5,
         progress_files = ?2,
         progress_dirs = ?3,
         progress_size = ?1,
         current_path = NULL
         WHERE id = ?6",
        params![
            total_size as i64,
            total_files as i64,
            total_dirs as i64,
            scan_time_ms as i64,
            root_json,
            id
        ]
    )?;
    Ok(())
}

pub fn fail_scan(
    conn: &Connection,
    id: &str,
    error_message: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE scans SET status = 'failed', error_message = ?1 WHERE id = ?2",
        params![error_message, id]
    )?;
    Ok(())
}

pub fn get_running_scans(conn: &Connection) -> Result<Vec<Scan>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, disks, status, total_size, total_files, total_dirs, 
                progress_files, progress_dirs, progress_size, current_path, scan_time_ms, root_json, error_message, created_at 
         FROM scans WHERE status = 'running' ORDER BY created_at DESC"
    )?;

    let scans = stmt.query_map([], |row| {
        Ok(Scan {
            id: row.get(0)?,
            path: row.get(1)?,
            disks: row.get(2)?,
            status: row.get(3)?,
            total_size: row.get(4)?,
            total_files: row.get(5)?,
            total_dirs: row.get(6)?,
            progress_files: row.get(7)?,
            progress_dirs: row.get(8)?,
            progress_size: row.get(9)?,
            current_path: row.get(10)?,
            scan_time_ms: row.get(11)?,
            root_json: row.get(12)?,
            error_message: row.get(13)?,
            created_at: row.get(14)?,
        })
    })?;

    scans.collect()
}

pub fn get_scan(conn: &Connection, id: &str) -> Result<Option<Scan>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, disks, status, total_size, total_files, total_dirs, 
                progress_files, progress_dirs, progress_size, current_path, scan_time_ms, root_json, error_message, created_at 
         FROM scans WHERE id = ?1"
    )?;

    let mut rows = stmt.query(params![id])?;

    if let Some(row) = rows.next()? {
        Ok(Some(Scan {
            id: row.get(0)?,
            path: row.get(1)?,
            disks: row.get(2)?,
            status: row.get(3)?,
            total_size: row.get(4)?,
            total_files: row.get(5)?,
            total_dirs: row.get(6)?,
            progress_files: row.get(7)?,
            progress_dirs: row.get(8)?,
            progress_size: row.get(9)?,
            current_path: row.get(10)?,
            scan_time_ms: row.get(11)?,
            root_json: row.get(12)?,
            error_message: row.get(13)?,
            created_at: row.get(14)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn list_scans(conn: &Connection, limit: i64) -> Result<Vec<Scan>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, disks, status, total_size, total_files, total_dirs, 
                progress_files, progress_dirs, progress_size, current_path, scan_time_ms, root_json, error_message, created_at 
         FROM scans ORDER BY 
         CASE WHEN status = 'running' THEN 0 ELSE 1 END,
         created_at DESC 
         LIMIT ?1"
    )?;

    let scans = stmt.query_map(params![limit], |row| {
        Ok(Scan {
            id: row.get(0)?,
            path: row.get(1)?,
            disks: row.get(2)?,
            status: row.get(3)?,
            total_size: row.get(4)?,
            total_files: row.get(5)?,
            total_dirs: row.get(6)?,
            progress_files: row.get(7)?,
            progress_dirs: row.get(8)?,
            progress_size: row.get(9)?,
            current_path: row.get(10)?,
            scan_time_ms: row.get(11)?,
            root_json: row.get(12)?,
            error_message: row.get(13)?,
            created_at: row.get(14)?,
        })
    })?;

    scans.collect()
}

pub fn delete_scan(conn: &Connection, id: &str) -> Result<bool> {
    let deleted = conn.execute("DELETE FROM scans WHERE id = ?1", params![id])?;
    Ok(deleted > 0)
}

/// Top-N children under `parent_path`, plus size/count of everything beyond the limit.
pub struct ChildrenPage {
    pub entries: Vec<ScanEntry>,
    pub others_size: u64,
    pub others_count: u64,
}

pub fn get_scan_children(
    conn: &Connection,
    scan_id: &str,
    parent_path: &str,
    limit: usize,
) -> Result<ChildrenPage> {
    let limit = limit.max(1) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, scan_id, path, name, parent_path, size, is_dir, modified
         FROM scan_entries
         WHERE scan_id = ?1 AND parent_path = ?2
         ORDER BY is_dir DESC, size DESC
         LIMIT ?3",
    )?;

    let entries: Vec<ScanEntry> = stmt
        .query_map(params![scan_id, parent_path, limit], |row| {
            Ok(ScanEntry {
                id: row.get(0)?,
                scan_id: row.get(1)?,
                path: row.get(2)?,
                name: row.get(3)?,
                parent_path: row.get(4)?,
                size: row.get(5)?,
                is_dir: row.get(6)?,
                modified: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    // Only probe totals when the page may be truncated.
    if (entries.len() as i64) < limit {
        return Ok(ChildrenPage {
            entries,
            others_size: 0,
            others_count: 0,
        });
    }

    let (total_size, total_count): (i64, i64) = conn.query_row(
        "SELECT COALESCE(SUM(size), 0), COUNT(*)
         FROM scan_entries
         WHERE scan_id = ?1 AND parent_path = ?2",
        params![scan_id, parent_path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let kept_size: i64 = entries.iter().map(|e| e.size).sum();
    let others_count = (total_count - entries.len() as i64).max(0) as u64;
    let others_size = (total_size - kept_size).max(0) as u64;

    Ok(ChildrenPage {
        entries,
        others_size,
        others_count,
    })
}

pub fn calculate_dir_sizes(conn: &Connection, scan_id: &str) -> Result<()> {
    // Single SQL statement that updates all directory sizes at once by
    // summing the sizes of their direct children. This replaces the previous
    // approach of one query + one update per directory (which could be
    // millions of round-trips for large filesystems).
    //
    // We process deepest-first via a recursive CTE so that when a parent
    // sums its children, any child directories have already been updated
    // with their aggregated sizes. However, SQLite doesn't guarantee update
    // ordering within a single UPDATE statement, so we iterate depth levels
    // from deepest to shallowest, updating one level at a time.
    info!("Calculating directory sizes for scan {}", scan_id);

    // Find the maximum directory path depth so we can iterate from deepest
    // to shallowest. Depth is approximated by counting '/' characters.
    let max_depth: i64 = conn.query_row(
        "SELECT COALESCE(MAX(LENGTH(path) - LENGTH(REPLACE(path, '/', ''))), 0) \
         FROM scan_entries WHERE scan_id = ?1 AND is_dir = 1",
        params![scan_id],
        |row| row.get(0),
    )?;

    // Update each depth level from deepest to shallowest. At each level,
    // set each dir's size = sum of its direct children's sizes (which by
    // this point have already been aggregated if they're dirs).
    for depth in (0..=max_depth).rev() {
        let updated = conn.execute(
            "UPDATE scan_entries \
             SET size = ( \
                 SELECT COALESCE(SUM(size), 0) FROM scan_entries child \
                 WHERE child.scan_id = ?1 \
                   AND child.parent_path = scan_entries.path \
             ) \
             WHERE scan_id = ?1 \
               AND is_dir = 1 \
               AND (LENGTH(path) - LENGTH(REPLACE(path, '/', ''))) = ?2",
            params![scan_id, depth],
        )?;
        debug!("Depth {}: updated {} dirs", depth, updated);
    }

    info!("Directory sizes calculated for scan {}", scan_id);
    Ok(())
}

pub fn get_entry_by_path(conn: &Connection, scan_id: &str, path: &str) -> Result<Option<ScanEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, scan_id, path, name, parent_path, size, is_dir, modified 
         FROM scan_entries WHERE scan_id = ?1 AND path = ?2",
    )?;

    let mut rows = stmt.query(params![scan_id, path])?;

    if let Some(row) = rows.next()? {
        Ok(Some(ScanEntry {
            id: row.get(0)?,
            scan_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            parent_path: row.get(4)?,
            size: row.get(5)?,
            is_dir: row.get(6)?,
            modified: row.get(7)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn count_scan_entries(conn: &Connection, scan_id: &str) -> Result<(i64, i64)> {
    let files: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scan_entries WHERE scan_id = ?1 AND is_dir = 0",
        params![scan_id],
        |row| row.get(0),
    )?;
    let dirs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM scan_entries WHERE scan_id = ?1 AND is_dir = 1",
        params![scan_id],
        |row| row.get(0),
    )?;
    Ok((files, dirs))
}

#[derive(Debug, Clone)]
pub struct ScanEntry {
    pub id: i64,
    pub scan_id: String,
    pub path: String,
    pub name: String,
    pub parent_path: String,
    pub size: i64,
    pub is_dir: bool,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub user_id: i64,
    pub expires_at: String,
    pub created_at: String,
    pub username: String,
    pub role: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Scan {
    pub id: String,
    pub path: String,
    pub disks: String,
    pub status: String,
    pub total_size: i64,
    pub total_files: i64,
    pub total_dirs: i64,
    pub progress_files: i64,
    pub progress_dirs: i64,
    pub progress_size: i64,
    pub current_path: Option<String>,
    pub scan_time_ms: i64,
    pub root_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
}
