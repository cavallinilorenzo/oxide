//! Finds Git repositories under the scan roots. A parallel walk with a depth
//! limit that never descends into a repository once found.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rayon::prelude::*;

/// How many folders below a scan root are looked into (the root is depth 0).
const MAX_DEPTH: usize = 4;

/// Dependency and build folders; nothing worth finding lives in them.
const SKIPPED: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "out",
    "vendor",
    "venv",
    "__pycache__",
    "Pods",
];

/// Conventional project folders, resolved against the user's home without configuration.
pub fn default_roots(user_home: &Path) -> Vec<PathBuf> {
    [
        "Developer",
        "Projects",
        "Code",
        "dev",
        "src",
        "workspace",
        "repos",
    ]
    .iter()
    .map(|folder| user_home.join(folder))
    .collect()
}

/// Canonical (symlink-resolved) paths of every repository under `roots`, sorted.
/// A repository is a folder holding a `.git` directory. Roots that don't exist
/// are ignored.
pub fn find_repositories(roots: &[PathBuf]) -> Vec<PathBuf> {
    let visited = Mutex::new(HashSet::new());
    let mut found: Vec<PathBuf> = roots
        .par_iter()
        .filter_map(|root| root.canonicalize().ok())
        .flat_map_iter(|root| walk(&root, 0, &visited))
        .collect();
    found.sort();
    found.dedup();
    found
}

fn walk(dir: &Path, depth: usize, visited: &Mutex<HashSet<PathBuf>>) -> Vec<PathBuf> {
    // `dir` is canonical, so a symlink loop or a second route to the same
    // folder is seen once.
    if !visited
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(dir.to_path_buf())
    {
        return vec![];
    }
    if dir.join(".git").is_dir() {
        return vec![dir.to_path_buf()];
    }
    if depth >= MAX_DEPTH {
        return vec![];
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let children: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || SKIPPED.contains(&name.as_ref()) {
                return false;
            }
            e.file_type()
                .map(|ft| ft.is_dir() || ft.is_symlink())
                .unwrap_or(false)
        })
        .filter_map(|e| e.path().canonicalize().ok())
        .filter(|p| p.is_dir())
        .collect();
    children
        .par_iter()
        .flat_map_iter(|child| walk(child, depth + 1, visited))
        .collect()
}
