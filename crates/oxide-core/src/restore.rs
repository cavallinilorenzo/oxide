//! Restoring a Thread's files to how they were before a chosen Turn. The
//! working tree is put back to the Turn's start Checkpoint, file by file, so
//! HEAD, the branches, the user's index and the ignored files are left alone.

use crate::checkpoint;
use crate::git::{run, run_with_env};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// How many paths one `git checkout-index` call writes; a longer list would
/// overflow the command line.
const PATHS_PER_CALL: usize = 64;

/// What a restore does to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreChange {
    /// The file is written back to how the Checkpoint had it.
    Rewritten,
    /// The file is brought back: it was deleted after the Checkpoint.
    Reinstated,
    /// The file is removed: it was created after the Checkpoint.
    Removed,
}

/// One file a restore changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFile {
    /// The file's path in the checkout.
    pub path: String,
    /// What the restore does to it.
    pub change: RestoreChange,
}

/// The files a restore would change, before it is done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    /// The Turn whose start Checkpoint the files go back to.
    pub turn_index: u32,
    /// The files that stand between the working tree and that Checkpoint.
    pub files: Vec<RestoreFile>,
}

/// What a restore did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    /// The Turn whose start Checkpoint the files went back to.
    pub turn_index: u32,
    /// The files that changed.
    pub files: Vec<RestoreFile>,
    /// Whether this undid a restore instead of making one.
    pub undone: bool,
}

/// A restore that can still be undone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRestore {
    /// The Turn whose start Checkpoint the files went back to.
    pub turn_index: u32,
    /// The files the restore changed.
    pub files: Vec<RestoreFile>,
}

/// A restore as it is kept: the Turn it restored to, the Checkpoint that undoes
/// it and the files it changed.
pub(crate) struct RestoreRecord {
    pub turn_index: u32,
    pub safety_ref: String,
    pub files: Vec<RestoreFile>,
}

/// The Checkpoint a restore takes first, so the restore can be undone. Its name
/// carries the Checkpoint's own commit, so no two restores share one.
pub(crate) fn safety_ref(thread_id: u32, commit: &str) -> String {
    format!("refs/oxide/checkpoints/{thread_id}/restore/{commit}")
}

/// Takes a Checkpoint of the working tree and keeps it, so a restore can be
/// undone. It is a Checkpoint like the Turns' own, and goes away with the Thread.
pub(crate) fn take_safety(cwd: &Path, thread_id: u32) -> Result<String> {
    let commit = checkpoint::snapshot(cwd)?;
    let reference = safety_ref(thread_id, &commit);
    run(cwd, &["update-ref", &reference, &commit])?;
    Ok(reference)
}

/// What the Transcript records about a restore.
pub(crate) fn marker(turn_index: u32, files: &[RestoreFile], undone: bool) -> String {
    let mut marker = if undone {
        format!("Undid the restore to before Turn {}", turn_index + 1)
    } else {
        format!(
            "Restored the files to how they were before Turn {}",
            turn_index + 1
        )
    };
    if !files.is_empty() {
        marker.push_str(": ");
        marker.push_str(
            &files
                .iter()
                .map(|file| format!("{} {}", file.path, phrase(file.change).1))
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    marker.push('.');
    marker
}

/// What the agent is told on the next prompt after a restore.
pub(crate) fn notice(turn_index: u32, files: &[RestoreFile], undone: bool) -> String {
    let mut notice = if undone {
        format!(
            "Oxide undid the restore to before Turn {}. The Thread's files are back as they were before the restore. These files changed on disk:\n",
            turn_index + 1
        )
    } else {
        format!(
            "Oxide restored this Thread's files to how they were before Turn {}. These files changed on disk:\n",
            turn_index + 1
        )
    };
    for file in files {
        notice.push_str(&format!("- {}: {}\n", file.path, phrase(file.change).0));
    }
    notice.push_str(if undone {
        "The files that the restore changed are on disk again.\n\n"
    } else {
        "The work of that Turn and of later Turns is no longer on disk; do not assume it is there.\n\n"
    });
    notice
}

/// What a restore did to a file, in the present and in the past.
fn phrase(change: RestoreChange) -> (&'static str, &'static str) {
    match change {
        RestoreChange::Rewritten => ("put back to how it was", "was put back to how it was"),
        RestoreChange::Reinstated => ("brought back", "was brought back"),
        RestoreChange::Removed => ("deleted", "was deleted"),
    }
}

/// The files that stand between the working tree and `source`, and what a
/// restore would do to each. The working tree is compared as a whole, so
/// untracked files count and ignored ones do not.
pub(crate) fn plan(cwd: &Path, source: &str) -> Result<Vec<RestoreFile>> {
    let current = checkpoint::working_tree(cwd)?;
    let out = run(
        cwd,
        &[
            "diff",
            "--name-status",
            "-z",
            "--no-renames",
            source,
            &current,
        ],
    )?;
    let mut fields = out.split('\0').filter(|field| !field.is_empty());
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        let path = fields.next().unwrap_or_default().to_string();
        let change = match status.as_bytes().first() {
            // The file was created after the Checkpoint: the restore removes it.
            Some(b'A') => RestoreChange::Removed,
            // The file was deleted after the Checkpoint: the restore brings it back.
            Some(b'D') => RestoreChange::Reinstated,
            _ => RestoreChange::Rewritten,
        };
        files.push(RestoreFile { path, change });
    }
    Ok(files)
}

/// Puts the working tree back to `source`, changing only the files `files` names.
pub(crate) fn apply(cwd: &Path, source: &str, files: &[RestoreFile]) -> Result<()> {
    for file in files
        .iter()
        .filter(|file| file.change == RestoreChange::Removed)
    {
        remove(cwd, &file.path)?;
    }
    let rewritten: Vec<&str> = files
        .iter()
        .filter(|file| file.change != RestoreChange::Removed)
        .map(|file| file.path.as_str())
        .collect();
    if rewritten.is_empty() {
        return Ok(());
    }
    checkout(cwd, source, &rewritten)
}

/// Undoes a restore: the files it changed go back to how the safety Checkpoint had
/// them, and only those. Work done after the restore stays where it is.
pub(crate) fn undo(cwd: &Path, source: &str, files: &[RestoreFile]) -> Result<Vec<RestoreFile>> {
    let undone: Vec<RestoreFile> = files
        .iter()
        .map(|file| RestoreFile {
            path: file.path.clone(),
            // The undo is the restore's mirror: a file the restore brought back is
            // removed again, one it removed is brought back.
            change: match file.change {
                RestoreChange::Rewritten => RestoreChange::Rewritten,
                RestoreChange::Reinstated => RestoreChange::Removed,
                RestoreChange::Removed => RestoreChange::Reinstated,
            },
        })
        .collect();
    apply(cwd, source, &undone)?;
    Ok(undone)
}

/// Deletes a path the Checkpoint did not have. A path Git named is inside the
/// checkout, so it is safe to remove.
fn remove(cwd: &Path, path: &str) -> Result<()> {
    let full = cwd.join(path);
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(Error::Io { path: full, source }),
    };
    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&full)
    } else {
        std::fs::remove_file(&full)
    };
    result.map_err(|source| Error::Io { path: full, source })
}

/// Writes the given paths of `source` back to the working tree. It goes through
/// a temporary index, so the user's own index is never touched.
fn checkout(cwd: &Path, source: &str, paths: &[&str]) -> Result<()> {
    let index = checkpoint::temp_index(cwd, "oxide-restore")?;
    let index_arg = index.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", index_arg.as_str())];
    let result = (|| -> Result<()> {
        run_with_env(cwd, &["read-tree", source], &env)?;
        for chunk in paths.chunks(PATHS_PER_CALL) {
            let mut args = vec!["checkout-index", "-f", "--"];
            args.extend_from_slice(chunk);
            run_with_env(cwd, &args, &env)?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&index);
    result
}
