use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
    pub file_count: Option<u64>,
    pub modified: Option<i64>,
}

impl FileNode {
    pub fn new_file(path: PathBuf, size: u64, modified: Option<i64>) -> Self {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
	// file_count is only populated where a real count exists (e.g. the
	// synthetic "Others" node); the tree endpoints have no per-node counts.
	Self {
		path,
		name,
		size,
		is_dir: false,
		children: None,
		file_count: None,
		modified,
	}
}

pub fn new_dir(path: PathBuf) -> Self {
	let name = path
		.file_name()
		.map(|n| n.to_string_lossy().to_string())
		.unwrap_or_else(|| "/".to_string());
	Self {
		path,
		name,
		size: 0,
		is_dir: true,
		children: Some(Vec::new()),
		file_count: None,
		modified: None,
	}
}
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRequest {
    pub id: String,
    pub path: String,
    /// Root paths to walk. When non-empty, the scanner walks each path in
    /// sequence within the same scan. When empty, falls back to `path`.
    #[serde(default)]
    pub paths: Vec<String>,
    pub max_depth: Option<usize>,
    pub follow_symlinks: bool,
    /// When true, don't cross filesystem boundaries (like `du -x`).
    /// Each root path is scanned independently without traversing into
    /// mount points on other filesystems.
    #[serde(default = "default_same_filesystem")]
    pub same_filesystem: bool,
}

fn default_same_filesystem() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub id: String,
    pub path: String,
    pub total_size: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub root: Option<FileNode>,
    pub scan_time_ms: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    pub scanned_files: u64,
    pub scanned_dirs: u64,
    pub current_path: String,
    pub is_complete: bool,
}

pub type ProgressCallback = Box<dyn Fn(&ScanProgress) + Send + Sync>;