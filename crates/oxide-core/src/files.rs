use crate::{Error, Result};
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Largest slice of a file Core hands to the webview; the rest is cut off.
pub const MAX_FILE_BYTES: u64 = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Path relative to the checkout root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// Empty for binary files.
    pub content: String,
    /// On-disk size in bytes.
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

/// Resolves `relative` inside `root`, refusing anything that leaves it
/// (`..`, absolute paths, symlinks pointing outside).
fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    let escape = || Error::InvalidPath(relative.to_string());
    let rel = Path::new(relative);
    if rel
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(escape());
    }
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |source| Error::Io { path, source }
    };
    let root = root.canonicalize().map_err(io(root))?;
    let full = root.join(rel);
    let full = full.canonicalize().map_err(io(&full))?;
    if full.starts_with(&root) {
        Ok(full)
    } else {
        Err(escape())
    }
}

/// The children of one directory of the checkout, skipping `.git` and
/// anything ignored by `.gitignore`; directories first, then by name.
pub fn list_dir(root: &Path, relative: &str) -> Result<Vec<FileEntry>> {
    let dir = resolve(root, relative)?;
    let prefix = relative.trim_matches('/');
    let mut entries = Vec::new();
    let walk = WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walk.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        entries.push(FileEntry { name, path, is_dir });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(entries)
}

/// Up to [`MAX_FILE_BYTES`] of a file, as text. Binary files return no content.
pub fn read_file(root: &Path, relative: &str) -> Result<FileContent> {
    let path = resolve(root, relative)?;
    let io = |source| Error::Io {
        path: path.clone(),
        source,
    };
    let file = File::open(&path).map_err(io)?;
    let size = file.metadata().map_err(io)?.len();
    let mut bytes = Vec::with_capacity(size.min(MAX_FILE_BYTES) as usize);
    file.take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Ok(FileContent {
            content: String::new(),
            size,
            truncated: false,
            binary: true,
        });
    }
    Ok(FileContent {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        size,
        truncated: size > MAX_FILE_BYTES,
        binary: false,
    })
}
