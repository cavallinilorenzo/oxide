use crate::{Error, Result};
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Write};
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
pub(crate) fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
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

/// Saves a complete UTF-8 document atomically, refusing stale buffers and links outside the checkout.
pub fn write_file(root: &Path, relative: &str, expected: &str, content: &str) -> Result<()> {
    let path = resolve(root, relative)?;
    let io = |source| Error::Io {
        path: path.clone(),
        source,
    };
    let metadata = std::fs::metadata(&path).map_err(io)?;
    if metadata.len() > MAX_FILE_BYTES || content.len() as u64 > MAX_FILE_BYTES {
        return Err(Error::Editor(
            "The editor supports complete text files up to 1 MiB.".into(),
        ));
    }
    let current = std::fs::read(&path).map_err(io)?;
    if current != expected.as_bytes() {
        return Err(Error::Editor(
            "This file changed on disk. Reload it or compare your changes before saving.".into(),
        ));
    }
    if metadata.permissions().readonly() {
        return Err(Error::Editor("This file is read-only on disk.".into()));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(io)?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(io)?;
    temporary.write_all(content.as_bytes()).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    // Recheck after preparing the replacement so changes made by a Provider are not silently lost.
    if std::fs::read(&path).map_err(io)? != current {
        return Err(Error::Editor(
            "This file changed on disk while saving. Reload it before saving again.".into(),
        ));
    }
    temporary.persist(&path).map_err(|e| io(e.error))?;
    Ok(())
}

/// The children of one directory of the checkout, skipping `.git` and
/// anything ignored by `.gitignore`; directories first, then by name.
pub fn create_file(root: &Path, relative: &str) -> Result<()> {
    let name = Path::new(relative)
        .file_name()
        .ok_or_else(|| Error::InvalidPath(relative.into()))?;
    let parent = Path::new(relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let parent = resolve(root, &parent.to_string_lossy())?;
    if Path::new(relative)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(Error::InvalidPath(relative.into()));
    }
    let path = parent.join(name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|source| Error::Io { path, source })?;
    Ok(())
}

pub fn find_files(root: &Path, query: &str) -> Vec<String> {
    let query = query.to_lowercase();
    WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .flatten()
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .filter_map(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .filter(|path| path.to_lowercase().contains(&query))
        .take(100)
        .collect()
}

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
    if bytes[..bytes.len().min(8192)].contains(&0)
        || (size <= MAX_FILE_BYTES && std::str::from_utf8(&bytes).is_err())
    {
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
