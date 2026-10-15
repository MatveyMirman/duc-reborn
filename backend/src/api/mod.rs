pub mod auth;
pub mod handlers;
pub mod models;

use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::scanner::CancelToken;

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub db_path: PathBuf,
    pub tree_dir: PathBuf,
    /// Cancellation tokens for in-flight scans, keyed by scan id. Presence of
    /// an entry implies the scan is currently running.
    pub running_scans: Arc<Mutex<HashMap<String, CancelToken>>>,
}

pub fn create_app_state(db: Connection, db_path: PathBuf, tree_dir: PathBuf) -> Arc<Mutex<AppState>> {
    Arc::new(Mutex::new(AppState {
        db: Arc::new(Mutex::new(db)),
        db_path,
        tree_dir,
        running_scans: Arc::new(Mutex::new(HashMap::new())),
    }))
}