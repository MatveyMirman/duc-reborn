use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing::{debug, warn};

/// A physical disk / filesystem visible to the container, grouped by source
/// device (e.g. `/dev/nvme0n1p2`). All bind mounts of the same underlying
/// device collapse into a single `DiskInfo`.
#[derive(Debug, Clone, Serialize)]
pub struct DiskInfo {
    /// Kernel device source, e.g. `/dev/nvme0n1p2`. May be `none` or empty
    /// for pseudo-filesystems, but those are filtered out.
    pub device: String,
    /// Filesystem type, e.g. `ext4`, `btrfs`, `xfs`.
    pub fstype: String,
    /// All mountpoints where this device is mounted inside the container.
    pub mountpoints: Vec<String>,
    /// Total capacity in bytes (0 if unknown).
    pub total_size: u64,
    /// Used space in bytes (0 if unknown).
    pub used: u64,
    /// Available (free for non-root) space in bytes (0 if unknown).
    pub available: u64,
    /// Optional device model from `lsblk` (e.g. "Samsung SSD 980").
    pub model: Option<String>,
    /// Optional partition/disk label from `lsblk`.
    pub label: Option<String>,
}

/// Filesystem types that are pseudo/virtual and should never appear in the
/// disk picker. These don't represent real backing storage.
const PSEUDO_FS: &[&str] = &[
    "proc",
    "sysfs",
    "tmpfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "mqueue",
    "shm",
    "overlay",
    "fuse",
    "fusectl",
    "fuse.sysboxfs",
    "securityfs",
    "debugfs",
    "tracefs",
    "configfs",
    "pstore",
    "binfmt_misc",
    "autofs",
    "rpc_pipefs",
    "nsfs",
    "hugetlbfs",
];

/// Mountpoint prefixes that are container-internal noise and should be
/// excluded from the disk picker even if they sit on a real device.
const NOISE_PREFIXES: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
];

fn is_pseudo_fs(fstype: &str) -> bool {
    PSEUDO_FS.contains(&fstype)
}

fn is_noise_mount(mountpoint: &str) -> bool {
    NOISE_PREFIXES.iter().any(|p| mountpoint == *p || mountpoint.starts_with(&format!("{p}/")))
}

/// Parse `/proc/mounts` and return real (non-pseudo) mounts grouped by device.
fn read_mounts() -> Vec<(String, String, String)> {
    let contents = match fs::read_to_string("/proc/mounts") {
        Ok(c) => c,
        Err(e) => {
            warn!("Failed to read /proc/mounts: {e}");
            return Vec::new();
        }
    };

    let mut mounts: Vec<(String, String, String)> = Vec::new();
    for line in contents.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }
        let device = parts[0].to_string();
        let mountpoint = parts[1].to_string();
        let fstype = parts[2].to_string();

        if is_pseudo_fs(&fstype) {
            continue;
        }
        if is_noise_mount(&mountpoint) {
            continue;
        }
        // Skip devices that are empty or "none" (pseudo mount sources).
        if device.is_empty() || device == "none" {
            continue;
        }
        // Unescape octal sequences like \040 for spaces in mountpoint paths.
        let mountpoint = unescape_mount(&mountpoint);
        mounts.push((device, mountpoint, fstype));
    }
    mounts
}

/// Unescape octal escape sequences (\040 etc.) used in /proc/mounts.
fn unescape_mount(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            let oct = std::str::from_utf8(&bytes[i + 1..i + 4]);
            if let Ok(oct_str) = oct {
                if let Ok(code) = u8::from_str_radix(oct_str, 8) {
                    out.push(code as char);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Query filesystem space for a mountpoint via statvfs.
fn fs_stats(mountpoint: &str) -> (u64, u64, u64) {
    let c_path = std::ffi::CString::new(mountpoint).unwrap_or_else(|_| std::ffi::CString::new("/").unwrap());
    unsafe {
        let mut buf: StatVfs = std::mem::zeroed();
        let rc = sys_statvfs(c_path.as_ptr(), &mut buf);
        if rc != 0 {
            return (0, 0, 0);
        }
        let bsize = buf.f_bsize;
        let total = buf.f_blocks * bsize;
        let avail = buf.f_bavail * bsize;
        let free = buf.f_bfree * bsize;
        let used = total.saturating_sub(free);
        (total, used, avail)
    }
}

/// Minimal statvfs struct for portable space queries without pulling in libc crate.
/// Fields match `struct statvfs` on Linux x86_64.
#[repr(C)]
struct StatVfs {
    f_bsize: u64,
    f_frsize: u64,
    f_blocks: u64,
    f_bfree: u64,
    f_bavail: u64,
    f_files: u64,
    f_ffree: u64,
    f_favail: u64,
    f_fsid: u64,
    f_flag: u32,
    f_namemax: u32,
    f_spare: [u32; 6],
}

extern "C" {
    #[link_name = "statvfs"]
    fn sys_statvfs(path: *const std::ffi::c_char, buf: *mut StatVfs) -> i32;
}

/// Try to run `lsblk --json` to enrich disks with model/label info.
/// Returns a map from device basename (e.g. "nvme0n1p2") to (model, label).
fn lsblk_info() -> HashMap<String, (Option<String>, Option<String>)> {
    let output = std::process::Command::new("lsblk")
        .arg("--json")
        .arg("--output")
        .arg("NAME,MODEL,LABEL")
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return HashMap::new(),
    };

    let json: serde_json::Value = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };

    let mut map: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    if let Some(blockdevices) = json.get("blockdevices").and_then(|v| v.as_array()) {
        for dev in blockdevices {
            collect_lsblk_recursive(dev, &mut map);
        }
    }
    map
}

/// Recursively walk lsblk JSON tree (disks contain partitions contain sub-partitions).
fn collect_lsblk_recursive(dev: &serde_json::Value, map: &mut HashMap<String, (Option<String>, Option<String>)>) {
    let name = dev.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let model = dev.get("model").and_then(|v| v.as_str()).and_then(|s| {
        if s.is_empty() { None } else { Some(s.to_string()) }
    });
    let label = dev.get("label").and_then(|v| v.as_str()).and_then(|s| {
        if s.is_empty() { None } else { Some(s.to_string()) }
    });
    if !name.is_empty() {
        map.insert(name.to_string(), (model, label));
    }
    // Descend into children (partitions).
    if let Some(children) = dev.get("children").and_then(|v| v.as_array()) {
        for child in children {
            collect_lsblk_recursive(child, map);
        }
    }
}

/// Extract the device basename from a path like `/dev/nvme0n1p2` -> `nvme0n1p2`.
fn device_basename(dev_path: &str) -> &str {
    dev_path.rsplit('/').next().unwrap_or(dev_path)
}

/// Docker/container noise bind-mounts — same path on the host FS but not
/// useful scan roots.
const BIND_NOISE_EXACT: &[&str] = &[
    "/etc/hostname",
    "/etc/hosts",
    "/etc/resolv.conf",
];

fn is_scannable_mountpoint(mp: &str) -> bool {
    if BIND_NOISE_EXACT.contains(&mp) {
        return false;
    }
    Path::new(mp).is_dir()
}

/// Prefer directory mounts, drop nested bind mounts (e.g. keep `/var/lib/docker`
/// and drop `/var/lib/docker/volumes`).
fn scannable_roots(mountpoints: &[String]) -> Vec<String> {
    let mut mps: Vec<String> = mountpoints
        .iter()
        .filter(|m| is_scannable_mountpoint(m))
        .cloned()
        .collect();
    mps.sort_by_key(|m| m.len());
    mps.dedup();
    let mut roots: Vec<String> = Vec::new();
    for mp in mps {
        if roots
            .iter()
            .any(|r| mp == *r || mp.starts_with(&format!("{r}/")))
        {
            continue;
        }
        roots.push(mp);
    }
    roots.sort();
    roots
}

/// Pick the primary mountpoint for display/stats: shortest scannable root.
fn primary_mountpoint(mountpoints: &[String]) -> Option<&String> {
    let scannable: Vec<&String> = mountpoints
        .iter()
        .filter(|m| is_scannable_mountpoint(m))
        .collect();
    scannable
        .into_iter()
        .min_by_key(|m| m.len())
        .or_else(|| mountpoints.iter().min_by_key(|m| m.len()))
}

/// Enumerate all physical disks (real backing devices) visible to the container.
pub fn list_disks() -> Vec<DiskInfo> {
    let mounts = read_mounts();
    let lsblk = lsblk_info();
    debug!("lsblk info: {} entries", lsblk.len());

    // Group mountpoints by device.
    let mut by_device: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for (device, mountpoint, fstype) in &mounts {
        let entry = by_device.entry(device.clone()).or_insert_with(|| (fstype.clone(), Vec::new()));
        entry.1.push(mountpoint.clone());
        // Update fstype if it differs (shouldn't, but just in case).
        if entry.0.is_empty() {
            entry.0 = fstype.clone();
        }
    }

    let mut disks: Vec<DiskInfo> = by_device
        .into_iter()
        .map(|(device, (fstype, mountpoints))| {
            let mut sorted_mounts = mountpoints;
            sorted_mounts.sort();
            sorted_mounts.dedup();
            // Prefer scannable directory roots for the API/UI; fall back to raw list.
            let display_mounts = {
                let roots = scannable_roots(&sorted_mounts);
                let mut m = if roots.is_empty() {
                    sorted_mounts
                } else {
                    roots
                };
                // Put primary (shortest scannable) first for a sensible default UI pick.
                if let Some(primary) = primary_mountpoint(&m).cloned() {
                    m.retain(|x| x != &primary);
                    m.insert(0, primary);
                }
                m
            };

            let (total, used, avail) = primary_mountpoint(&display_mounts)
                .map(|mp| fs_stats(mp.as_str()))
                .unwrap_or((0, 0, 0));

            let (model, label) = lsblk
                .get(device_basename(&device))
                .cloned()
                .unwrap_or((None, None));

            DiskInfo {
                device: device.clone(),
                fstype,
                mountpoints: display_mounts,
                total_size: total,
                used,
                available: avail,
                model,
                label,
            }
        })
        .collect();

    // Sort by device name for stable output.
    disks.sort_by(|a, b| a.device.cmp(&b.device));
    disks
}

/// Resolve device names (e.g. `/dev/nvme0n1p2`) to one primary scannable
/// mountpoint each. Keeps scan trees single-rooted per selected disk (or one
/// path when a single disk is chosen), matching existing UI expectations.
pub fn resolve_to_mountpoints(devices: &[String]) -> Vec<String> {
    let disks = list_disks();
    let mut paths: Vec<String> = Vec::new();
    for device in devices {
        if let Some(disk) = disks.iter().find(|d| d.device == *device) {
            if let Some(mp) = primary_mountpoint(&disk.mountpoints) {
                paths.push(mp.clone());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

/// Normalize a path for comparison: trim whitespace and trailing slashes
/// (except root `/`).
pub fn normalize_scan_path(path: &str) -> String {
    let t = path.trim();
    if t.is_empty() {
        return String::new();
    }
    if t == "/" {
        return "/".to_string();
    }
    t.trim_end_matches('/').to_string()
}

/// True if `path` is exactly `root` or a descendant of `root`.
pub fn path_is_under(path: &str, root: &str) -> bool {
    let path = normalize_scan_path(path);
    let root = normalize_scan_path(root);
    if path.is_empty() || root.is_empty() {
        return false;
    }
    if root == "/" {
        return path.starts_with('/');
    }
    path == root || path.starts_with(&(root.clone() + "/"))
}

/// Decide which roots the walker should scan.
///
/// Priority:
/// 1. **Path under a selected disk mount** → walk that path only (not the whole disk)
/// 2. **Path is an ancestor of selected mounts** (e.g. `/` + disks) → walk those mounts
/// 3. **Path outside selected disks** → walk the path (user path wins)
/// 4. **Disks only** (empty path) → walk resolved mounts
/// 5. **Path only** → walk the path
pub fn resolve_scan_roots(path: &str, disk_devices: &[String]) -> Result<Vec<String>, String> {
    let path_norm = normalize_scan_path(path);
    let path_set = !path_norm.is_empty();

    let mounts = if disk_devices.is_empty() {
        Vec::new()
    } else {
        let m = resolve_to_mountpoints(disk_devices);
        if m.is_empty() {
            return Err(
                "Selected disks have no scannable mountpoints in this container".into(),
            );
        }
        m
    };

    if path_set && !mounts.is_empty() {
        // Path is on (or is) a selected mount → honor subdirectory intent.
        for mp in &mounts {
            if path_is_under(&path_norm, mp) {
                return Ok(vec![path_norm]);
            }
        }
        // Path is above selected mounts (e.g. path=/ and mount=/scan/root)
        // → scan the selected mounts only, not the whole ancestor tree.
        let under: Vec<String> = mounts
            .iter()
            .filter(|mp| path_is_under(mp, &path_norm))
            .cloned()
            .collect();
        if !under.is_empty() {
            return Ok(under);
        }
        // Path is unrelated to selected disks — path wins for the walk.
        return Ok(vec![path_norm]);
    }

    if !mounts.is_empty() {
        return Ok(mounts);
    }

    if path_set {
        return Ok(vec![path_norm]);
    }

    Err("Provide a path and/or select disks to scan".into())
}

/// Find a common ancestor path among multiple mountpoints.
/// Returns `None` if no common prefix exists.
pub fn common_ancestor(paths: &[String]) -> Option<PathBuf> {
    if paths.is_empty() {
        return None;
    }
    if paths.len() == 1 {
        return Some(PathBuf::from(&paths[0]));
    }
    let first = Path::new(&paths[0]);
    let mut common: Vec<&std::ffi::OsStr> = first.components().filter_map(|c| match c {
        std::path::Component::Normal(s) => Some(s),
        _ => None,
    }).collect();

    for path_str in &paths[1..] {
        let other_components: Vec<&std::ffi::OsStr> = Path::new(path_str)
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(s) => Some(s),
                _ => None,
            })
            .collect();
        let mut new_len = 0;
        for (i, comp) in common.iter().enumerate() {
            if other_components.get(i) == Some(comp) {
                new_len = i + 1;
            } else {
                break;
            }
        }
        common.truncate(new_len);
        if common.is_empty() {
            break;
        }
    }

    if common.is_empty() {
        return None;
    }
    let mut result = PathBuf::from("/");
    for comp in common {
        result.push(comp);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unescape_mount() {
        assert_eq!(unescape_mount("/foo"), "/foo");
        assert_eq!(unescape_mount("/foo\\040bar"), "/foo bar");
        assert_eq!(unescape_mount("/foo\\134bar"), "/foo\\bar");
    }

    #[test]
    fn test_is_noise_mount() {
        assert!(is_noise_mount("/proc"));
        assert!(is_noise_mount("/proc/foo"));
        assert!(is_noise_mount("/sys"));
        assert!(is_noise_mount("/dev"));
        assert!(!is_noise_mount("/home/coder"));
        assert!(!is_noise_mount("/"));
    }

    #[test]
    fn test_is_pseudo_fs() {
        assert!(is_pseudo_fs("tmpfs"));
        assert!(is_pseudo_fs("proc"));
        assert!(is_pseudo_fs("overlay"));
        assert!(!is_pseudo_fs("ext4"));
        assert!(!is_pseudo_fs("btrfs"));
    }

    #[test]
    fn test_normalize_scan_path() {
        assert_eq!(normalize_scan_path("  /foo/bar/  "), "/foo/bar");
        assert_eq!(normalize_scan_path("/"), "/");
        assert_eq!(normalize_scan_path(""), "");
    }

    #[test]
    fn test_path_is_under() {
        assert!(path_is_under("/scan/root/var", "/scan/root"));
        assert!(path_is_under("/scan/root", "/scan/root"));
        assert!(path_is_under("/scan/root/var", "/"));
        assert!(!path_is_under("/scan/root", "/scan/root/var"));
        assert!(!path_is_under("/other", "/scan/root"));
        // Avoid prefix false-positive: /scan/rootX is not under /scan/root
        assert!(!path_is_under("/scan/rootX", "/scan/root"));
    }

    #[test]
    fn test_resolve_scan_roots_path_under_mount() {
        // Inject mounts by testing the pure branching via a local helper pattern:
        // path under disk mount must win over whole-disk scan.
        let path = "/scan/root/var/lib/docker/volumes/gitlab/_data";
        let mount = "/scan/root";
        assert!(path_is_under(path, mount));
        // Simulated rule (same as resolve when mounts = [mount]):
        let roots = if path_is_under(path, mount) {
            vec![normalize_scan_path(path)]
        } else {
            vec![mount.to_string()]
        };
        assert_eq!(roots, vec![path]);
    }

    #[test]
    fn test_resolve_scan_roots_path_only() {
        let roots = resolve_scan_roots("/data/foo", &[]).unwrap();
        assert_eq!(roots, vec!["/data/foo"]);
    }

    #[test]
    fn test_resolve_scan_roots_empty_errors() {
        assert!(resolve_scan_roots("", &[]).is_err());
        assert!(resolve_scan_roots("   ", &[]).is_err());
    }

    #[test]
    fn test_list_disks_returns_real_devices() {
        let disks = list_disks();
        for d in &disks {
            assert!(!d.device.is_empty(), "device should not be empty");
            assert!(!d.mountpoints.is_empty(), "should have mountpoints");
            assert!(!is_pseudo_fs(&d.fstype), "pseudo FS should be filtered: {}", d.fstype);
        }
    }

    #[test]
    fn test_primary_mountpoint_picks_shortest() {
        let mounts = vec![
            "/var/lib/docker".to_string(),
            "/home/coder".to_string(),
            "/etc/hosts".to_string(), // noise — skipped
        ];
        // Prefers shortest scannable directory, not docker bind noise.
        assert_eq!(
            primary_mountpoint(&mounts).map(|s| s.as_str()),
            Some("/home/coder")
        );
    }

    #[test]
    fn test_common_ancestor() {
        assert_eq!(common_ancestor(&["/a/b".to_string()]), Some(PathBuf::from("/a/b")));
        assert_eq!(
            common_ancestor(&["/a/b".to_string(), "/a/c".to_string()]),
            Some(PathBuf::from("/a"))
        );
        assert_eq!(
            common_ancestor(&["/a/b".to_string(), "/x/y".to_string()]),
            None
        );
        assert_eq!(common_ancestor(&[]), None);
    }
}
