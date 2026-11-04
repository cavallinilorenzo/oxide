//! Checkpoints: a commit of the working tree (untracked files included, ignored
//! ones not) made through a temporary index, so the user's index, stash,
//! HEAD and branches are never touched. Kept under
//! `refs/oxide/checkpoints/<thread>/<turn>/{start,end}`; diffed, and restored
//! from (ADR-0011).

use crate::Result;
use crate::git::{run, run_with_env};
use crate::git_diff::{Diff, diff_against};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Start,
    End,
}

fn ref_name(thread_id: u32, turn_index: u32, phase: Phase) -> String {
    let phase = match phase {
        Phase::Start => "start",
        Phase::End => "end",
    };
    format!("refs/oxide/checkpoints/{thread_id}/{turn_index}/{phase}")
}

/// Records a Checkpoint of the working tree. Best effort: a directory that is
/// not a Git checkout simply has none.
pub(crate) fn take(cwd: &Path, thread_id: u32, turn_index: u32, phase: Phase) {
    let _ = snapshot(cwd).and_then(|commit| {
        run(
            cwd,
            &[
                "update-ref",
                &ref_name(thread_id, turn_index, phase),
                &commit,
            ],
        )
    });
}

/// Drops every Checkpoint of the Thread. Best effort, like [`take`].
pub(crate) fn forget(cwd: &Path, thread_id: u32) {
    let prefix = format!("refs/oxide/checkpoints/{thread_id}/");
    let Ok(refs) = run(cwd, &["for-each-ref", "--format=%(refname)", &prefix]) else {
        return;
    };
    for name in refs.lines().filter(|l| !l.is_empty()) {
        let _ = run(cwd, &["update-ref", "-d", name]);
    }
}

/// The commit one of a Turn's Checkpoints points at, if that Checkpoint exists.
fn resolve(cwd: &Path, thread_id: u32, turn_index: u32, phase: Phase) -> Option<String> {
    run(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{}^{{commit}}", ref_name(thread_id, turn_index, phase)),
        ],
    )
    .ok()
    .map(|commit| commit.trim().to_string())
}

/// Whether the Turn has a start Checkpoint, so there is something to diff.
pub(crate) fn has_start(cwd: &Path, thread_id: u32, turn_index: u32) -> bool {
    resolve(cwd, thread_id, turn_index, Phase::Start).is_some()
}

/// The tree of a Turn's start Checkpoint: what the files were before the Turn.
pub(crate) fn start_tree(cwd: &Path, thread_id: u32, turn_index: u32) -> Result<String> {
    tree_of(cwd, &ref_name(thread_id, turn_index, Phase::Start))
}

/// The tree of a Checkpoint kept under `reference`.
pub(crate) fn tree_of(cwd: &Path, reference: &str) -> Result<String> {
    let name = format!("{reference}^{{tree}}");
    let tree = run(cwd, &["rev-parse", "--verify", "--quiet", &name])?;
    Ok(tree.trim().to_string())
}

/// The two revisions a Turn is diffed between. While the Turn runs, its end is
/// the working tree right now; a Turn with no start Checkpoint has none.
pub(crate) fn turn_revs(
    cwd: &Path,
    thread_id: u32,
    turn_index: u32,
) -> Result<Option<(String, String)>> {
    let Some(start) = resolve(cwd, thread_id, turn_index, Phase::Start) else {
        return Ok(None);
    };
    let end = match resolve(cwd, thread_id, turn_index, Phase::End) {
        Some(end) => end,
        None => snapshot(cwd)?,
    };
    Ok(Some((start, end)))
}

/// What the Turn changed: its two Checkpoints diffed.
pub(crate) fn turn_diff(cwd: &Path, thread_id: u32, turn_index: u32) -> Result<Diff> {
    let files = match turn_revs(cwd, thread_id, turn_index)? {
        Some((start, end)) => diff_against(cwd, &[&start, &end])?,
        None => Vec::new(),
    };
    Ok(Diff { base: None, files })
}

/// What the Thread changed: the first Turn's start Checkpoint against the last Turn's end
/// Checkpoint, or the working tree while the last Turn has no end. `None` without a start
/// Checkpoint. Unlike summing each Turn, a file rewritten across Turns is measured once, as the
/// reviewer sees it.
pub(crate) fn thread_diff(
    cwd: &Path,
    thread_id: u32,
    turn_indexes: &[u32],
) -> Result<Option<Diff>> {
    let Some(first) = turn_indexes
        .iter()
        .copied()
        .filter(|&turn_index| has_start(cwd, thread_id, turn_index))
        .min()
    else {
        return Ok(None);
    };
    let Some(last) = turn_indexes.iter().copied().max() else {
        return Ok(None);
    };
    let start = start_tree(cwd, thread_id, first)?;
    let end = match resolve(cwd, thread_id, last, Phase::End) {
        Some(end) => end,
        None => working_tree(cwd)?,
    };
    Ok(Some(Diff {
        base: None,
        files: diff_against(cwd, &[&start, &end])?,
    }))
}

/// Whether the working tree right now matches a Turn's end Checkpoint. Read-only: it never writes
/// an object. `None` when the Turn has no end Checkpoint.
pub(crate) fn working_tree_matches_end(
    cwd: &Path,
    thread_id: u32,
    turn_index: u32,
) -> Option<bool> {
    let end = resolve(cwd, thread_id, turn_index, Phase::End)?;
    if run(cwd, &["--no-optional-locks", "diff", "--quiet", &end, "--"]).is_err() {
        return Some(false);
    }
    let untracked = run(
        cwd,
        &[
            "--no-optional-locks",
            "ls-files",
            "--others",
            "--exclude-standard",
        ],
    )
    .ok()?;
    Some(untracked.is_empty())
}

/// A parentless commit of the working tree, written without touching the real index.
pub(crate) fn snapshot(cwd: &Path) -> Result<String> {
    let index = temp_index(cwd, "oxide-checkpoint")?;
    let result = commit_through(cwd, &index.to_string_lossy());
    let _ = std::fs::remove_file(&index);
    result
}

/// A tree of the working tree, written without touching the real index.
pub(crate) fn working_tree(cwd: &Path) -> Result<String> {
    let index = temp_index(cwd, "oxide-tree")?;
    let result = tree_through(cwd, &index.to_string_lossy());
    let _ = std::fs::remove_file(&index);
    result
}

/// A path for a temporary index, inside the repository's own Git directory.
pub(crate) fn temp_index(cwd: &Path, kind: &str) -> Result<PathBuf> {
    let git_dir = PathBuf::from(run(cwd, &["rev-parse", "--absolute-git-dir"])?.trim());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    Ok(git_dir.join(format!("{kind}-{}-{nanos}.index", std::process::id())))
}

fn tree_through(cwd: &Path, index: &str) -> Result<String> {
    let env = [("GIT_INDEX_FILE", index)];
    run_with_env(cwd, &["add", "--all", "--", "."], &env)?;
    let tree = run_with_env(cwd, &["write-tree"], &env)?;
    Ok(tree.trim().to_string())
}

fn commit_through(cwd: &Path, index: &str) -> Result<String> {
    let env = [
        ("GIT_INDEX_FILE", index),
        ("GIT_AUTHOR_NAME", "Oxide"),
        ("GIT_AUTHOR_EMAIL", "oxide@localhost"),
        ("GIT_COMMITTER_NAME", "Oxide"),
        ("GIT_COMMITTER_EMAIL", "oxide@localhost"),
    ];
    run_with_env(cwd, &["add", "--all", "--", "."], &env)?;
    let tree = run_with_env(cwd, &["write-tree"], &env)?;
    let commit = run_with_env(
        cwd,
        &["commit-tree", tree.trim(), "-m", "oxide checkpoint"],
        &env,
    )?;
    Ok(commit.trim().to_string())
}
