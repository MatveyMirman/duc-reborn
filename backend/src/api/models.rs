use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub message: String,
    pub user: Option<UserInfo>,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    pub path: String,
    #[serde(default = "default_max_depth")]
    pub max_depth: Option<usize>,
    #[serde(default = "default_follow_symlinks")]
    pub follow_symlinks: bool,
    /// Optional physical devices (e.g. `/dev/nvme0n1p2`). Used to scope or
    /// seed mount roots; never silently replaces a more specific `path`.
    #[serde(default)]
    pub disks: Vec<String>,
    /// When true, don't cross filesystem boundaries (like `du -x`).
    /// Defaults to true so bind/overlay mounts are not walked by accident.
    #[serde(default = "default_same_filesystem")]
    pub same_filesystem: bool,
}

fn default_max_depth() -> Option<usize> {
    None
}

fn default_follow_symlinks() -> bool {
    false
}

fn default_same_filesystem() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ScanResponse {
    pub id: String,
    pub path: String,
    /// Actual filesystem roots the walker will visit.
    pub roots: Vec<String>,
    pub disks: Vec<String>,
    pub same_filesystem: bool,
    pub total_size: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub scan_time_ms: u64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct HistoryItem {
    pub id: String,
    pub path: String,
    pub disks: String,
    pub status: String,
    pub total_size: i64,
    pub total_files: i64,
    pub total_dirs: i64,
    pub progress_files: Option<i64>,
    pub progress_dirs: Option<i64>,
    pub progress_size: Option<i64>,
    pub current_path: Option<String>,
    pub scan_time_ms: i64,
    pub error_message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct ScanStatusResponse {
    pub id: String,
    pub path: String,
    pub status: String,
    pub progress_files: i64,
    pub progress_dirs: i64,
    pub progress_size: i64,
    pub current_path: Option<String>,
    pub total_files: Option<i64>,
    pub total_dirs: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AuthStatus {
    pub authenticated: bool,
    pub user: Option<UserInfo>,
}
