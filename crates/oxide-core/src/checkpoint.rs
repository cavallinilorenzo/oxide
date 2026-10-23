//! Checkpoints: a commit of the working tree (untracked files included, ignored
//! ones not) made through a temporary index, so the user's index, stash,
//! HEAD and branches are never touched. Kept under
//! `refs/oxide/checkpoints/<thread>/<turn>/{start,end}`; only ever diffed,
//! never restored from.

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

/// What the Turn changed: its two Checkpoints diffed. While the Turn runs, its
/// end is the working tree right now; a Turn with no start Checkpoint has no diff.
pub(crate) fn turn_diff(cwd: &Path, thread_id: u32, turn_index: u32) -> Result<Diff> {
    let empty = || Diff {
        base: None,
        files: Vec::new(),
    };
    let resolve = |phase| {
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
        .map(|s| s.trim().to_string())
    };
    let Some(start) = resolve(Phase::Start) else {
        return Ok(empty());
    };
    let end = match resolve(Phase::End) {
        Some(end) => end,
        None => snapshot(cwd)?,
    };
    Ok(Diff {
        base: None,
        files: diff_against(cwd, &[&start, &end])?,
    })
}

/// A parentless commit of the working tree, written without touching the real index.
fn snapshot(cwd: &Path) -> Result<String> {
    let git_dir = PathBuf::from(run(cwd, &["rev-parse", "--absolute-git-dir"])?.trim());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let index = git_dir.join(format!("oxide-checkpoint-{}-{nanos}", std::process::id()));
    let result = commit_through(cwd, &index.to_string_lossy());
    let _ = std::fs::remove_file(&index);
    result
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
