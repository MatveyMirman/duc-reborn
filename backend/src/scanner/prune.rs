use crate::scanner::types::FileNode;

/// Prune a FileNode tree to limit depth and max children per node.
/// Returns a new tree with:
/// - At most `max_children` per directory (sorted by size descending)
/// - Remaining items aggregated into a synthetic "Others" node
/// - Recursion truncated at `remaining_depth` (0 = just this node, no children)
pub fn prune_tree(node: &FileNode, remaining_depth: usize, max_children: usize) -> FileNode {
    let mut result = FileNode {
        path: node.path.clone(),
        name: node.name.clone(),
        size: node.size,
        is_dir: node.is_dir,
        children: None,
        file_count: node.file_count,
        modified: node.modified,
    };

    if remaining_depth == 0 {
        return result;
    }

    let children = match &node.children {
        Some(c) if !c.is_empty() => c,
        _ => return result,
    };

    // Separate dirs and files
    let mut dirs: Vec<&FileNode> = children.iter().filter(|c| c.is_dir).collect();
    let mut files: Vec<&FileNode> = children.iter().filter(|c| !c.is_dir).collect();

    // Sort by size descending
    dirs.sort_by_key(|d| std::cmp::Reverse(d.size));
    files.sort_by_key(|f| std::cmp::Reverse(f.size));

    let mut kept: Vec<FileNode> = Vec::new();
    let mut others_size: u64 = 0;
    let mut others_count: u64 = 0;

    // Strategy: interleave dirs and files, keeping largest items first.
    // Directories are generally more interesting for navigation, so we
    // give them a slight priority by consuming from dirs first when sizes are comparable.
    let mut di = 0;
    let mut fi = 0;

    while kept.len() < max_children && (di < dirs.len() || fi < files.len()) {
        let take_dir = match (dirs.get(di), files.get(fi)) {
            (Some(d), Some(f)) => d.size >= f.size,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };

        if take_dir {
            kept.push(prune_tree(dirs[di], remaining_depth.saturating_sub(1), max_children));
            di += 1;
        } else {
            kept.push(files[fi].clone());
            fi += 1;
        }
    }

    // Aggregate the rest into "Others"
    while di < dirs.len() {
        others_size += dirs[di].size;
        others_count += dirs[di].file_count.unwrap_or(1);
        di += 1;
    }
    while fi < files.len() {
        others_size += files[fi].size;
        others_count += 1;
        fi += 1;
    }

    if others_size > 0 {
        let others = FileNode {
            path: node.path.join("__others__"),
            name: "Others".to_string(),
            size: others_size,
            is_dir: true,
            children: None,
            file_count: Some(others_count),
            modified: None,
        };
        kept.push(others);
    }

    result.children = Some(kept);
    result
}

/// Find a subtree by absolute path within a FileNode tree.
/// Returns a clone of the matching node if found.
pub fn find_subtree<'a>(node: &'a FileNode, target_path: &std::path::Path) -> Option<&'a FileNode> {
    if node.path == target_path {
        return Some(node);
    }
    if let Some(children) = &node.children {
        for child in children {
            if let Some(found) = find_subtree(child, target_path) {
                return Some(found);
            }
        }
    }
    None
}
