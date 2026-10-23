//! Git for a Project's main checkout, through the `git` CLI: argument arrays,
//! never a shell. Reads run concurrently; mutating commands are serialized
//! per checkout.

use crate::{Error, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Minimum time between two background fetches of one checkout.
pub const FETCH_INTERVAL: Duration = Duration::from_secs(60);

/// Untracked files larger than this are not line-counted for the dirty chip.
pub(crate) const MAX_COUNTED_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// `None` while HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// Lines added by uncommitted changes, untracked files included.
    pub added: u32,
    pub removed: u32,
    /// Files with uncommitted changes, untracked included.
    pub changed_files: u32,
    /// Why the branch picker is disabled, if it is.
    pub picker_disabled_reason: Option<String>,
    /// A branch pushing to which needs the user's explicit consent.
    pub protected: bool,
    /// On a branch with commits that has no upstream yet, while an `origin`
    /// exists: the first push will publish it.
    pub unpublished: bool,
}

/// Branches that Oxide never pushes to without being told to.
const PROTECTED_BRANCHES: [&str; 2] = ["main", "master"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// `feature` for a local branch, `origin/feature` for a remote one.
    pub name: String,
    pub remote: bool,
    pub current: bool,
}

/// Per-checkout locks for mutating Git commands, and the throttle for
/// background fetches.
#[derive(Default)]
pub struct GitState {
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    last_fetch: Mutex<HashMap<PathBuf, Instant>>,
}

impl GitState {
    pub fn mutate<T>(&self, cwd: &Path, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let lock = Arc::clone(
            self.locks
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(cwd.to_path_buf())
                .or_default(),
        );
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }

    /// Fetches unless the last fetch of this checkout was under
    /// [`FETCH_INTERVAL`] before `now`; returns whether it fetched. A failed
    /// fetch does not start a new interval.
    pub fn fetch(&self, cwd: &Path, now: Instant) -> Result<bool> {
        let due = |last: Option<&Instant>| {
            last.is_none_or(|last| now.saturating_duration_since(*last) >= FETCH_INTERVAL)
        };
        if !due(self.last(cwd).as_ref()) {
            return Ok(false);
        }
        self.mutate(cwd, || {
            // Another caller may have fetched while this one waited.
            if !due(self.last(cwd).as_ref()) {
                return Ok(false);
            }
            run(cwd, &["fetch", "--prune"])?;
            self.last_fetch
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(cwd.to_path_buf(), now);
            Ok(true)
        })
    }

    fn last(&self, cwd: &Path) -> Option<Instant> {
        self.last_fetch
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(cwd)
            .copied()
    }
}

pub(crate) fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    run_with_env(cwd, args, &[])
}

pub(crate) fn run_with_env(cwd: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .envs(env.iter().copied())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::Git(format!("could not run git: {e}")))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout)
    } else {
        stderr
    };
    Err(Error::Git(message.trim().to_string()))
}

pub(crate) fn succeeds(cwd: &Path, args: &[&str]) -> bool {
    run(cwd, args).is_ok()
}

pub(crate) fn ref_exists(cwd: &Path, name: &str) -> bool {
    succeeds(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{name}^{{commit}}"),
        ],
    )
}

pub fn status(cwd: &Path) -> Result<GitStatus> {
    let porcelain = run(
        cwd,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut status = GitStatus {
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        added: 0,
        removed: 0,
        changed_files: 0,
        picker_disabled_reason: None,
        protected: false,
        unpublished: false,
    };
    let mut untracked = Vec::new();
    let mut tracked = 0;
    let mut records = porcelain.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            match header.split_once(' ') {
                Some(("branch.head", head)) if head != "(detached)" => {
                    status.branch = Some(head.to_string())
                }
                Some(("branch.upstream", upstream)) => status.upstream = Some(upstream.to_string()),
                Some(("branch.ab", ab)) => {
                    let mut counts = ab.split(' ').map(|n| n[1..].parse().unwrap_or(0));
                    status.ahead = counts.next().unwrap_or(0);
                    status.behind = counts.next().unwrap_or(0);
                }
                _ => {}
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            untracked.push(path.to_string());
        } else if record.starts_with("2 ") {
            // Renames carry the original path as a separate record.
            records.next();
            tracked += 1;
        } else if record.starts_with("1 ") || record.starts_with("u ") {
            tracked += 1;
        }
    }
    status.changed_files = tracked + untracked.len() as u32;

    let has_head = succeeds(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    status.protected = status
        .branch
        .as_deref()
        .is_some_and(|b| PROTECTED_BRANCHES.contains(&b));
    status.unpublished = has_head
        && status.branch.is_some()
        && status.upstream.is_none()
        && succeeds(cwd, &["config", "--get", "remote.origin.url"]);

    let base = if has_head {
        "HEAD".to_string()
    } else {
        // No commits yet: diff against the empty tree.
        run(cwd, &["hash-object", "-t", "tree", "/dev/null"]).unwrap_or_default()
    };
    if !base.trim().is_empty() {
        let numstat = run(
            cwd,
            &[
                "--no-optional-locks",
                "diff",
                "--numstat",
                "--no-renames",
                base.trim(),
                "--",
            ],
        )?;
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            // Binary files report `-`.
            status.added += cols.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            status.removed += cols.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
    }
    use rayon::prelude::*;

    status.added += untracked
        .par_iter()
        .map(|p| count_lines(&cwd.join(p)))
        .sum::<u32>();
    Ok(status)
}

/// Lines in a text file, as `git diff` counts them; 0 for binary, oversized
/// or unreadable files.
fn count_lines(path: &Path) -> u32 {
    let read = || -> std::io::Result<Option<u32>> {
        // Symlinks may point outside the checkout; never read through them.
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.is_file() || meta.len() > MAX_COUNTED_BYTES {
            return Ok(None);
        }
        let file = File::open(path)?;
        let mut bytes = Vec::with_capacity(meta.len().min(MAX_COUNTED_BYTES) as usize);
        file.take(MAX_COUNTED_BYTES).read_to_end(&mut bytes)?;
        if bytes[..bytes.len().min(8000)].contains(&0) {
            return Ok(None);
        }
        let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
        let unterminated = bytes.last().is_some_and(|b| *b != b'\n');
        Ok(Some(newlines + u32::from(unterminated)))
    };
    read().ok().flatten().unwrap_or(0)
}

pub fn list_branches(cwd: &Path) -> Result<Vec<GitBranch>> {
    let current = run(cwd, &["branch", "--show-current"])?.trim().to_string();
    let refs = run(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "--sort=refname",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    for name in refs.lines() {
        if let Some(local) = name.strip_prefix("refs/heads/") {
            locals.push(local.to_string());
        } else if let Some(remote) = name.strip_prefix("refs/remotes/")
            && !remote.ends_with("/HEAD")
        {
            remotes.push(remote.to_string());
        }
    }
    let local_set: HashSet<_> = locals.iter().cloned().collect();
    let mut branches: Vec<_> = locals
        .into_iter()
        .map(|name| GitBranch {
            current: name == current,
            name,
            remote: false,
        })
        .collect();
    // A remote branch that already has a local counterpart adds nothing.
    branches.extend(
        remotes
            .into_iter()
            .filter(|r| {
                r.split_once('/')
                    .is_none_or(|(_, branch)| !local_set.contains(branch))
            })
            .map(|name| GitBranch {
                name,
                remote: true,
                current: false,
            }),
    );
    Ok(branches)
}

fn checked_name(cwd: &Path, name: &str) -> Result<()> {
    if name.starts_with('-') || !succeeds(cwd, &["check-ref-format", "--branch", name]) {
        return Err(Error::Git(format!("`{name}` is not a valid branch name")));
    }
    Ok(())
}

/// Checks out a local branch, or a remote one as a new tracking branch.
pub fn checkout(cwd: &Path, name: &str) -> Result<()> {
    checked_name(cwd, name)?;
    let local = format!("refs/heads/{name}");
    let remote = format!("refs/remotes/{name}");
    if succeeds(cwd, &["show-ref", "--verify", "--quiet", &local]) {
        run(cwd, &["checkout", name, "--"])?;
    } else if succeeds(cwd, &["show-ref", "--verify", "--quiet", &remote]) {
        run(cwd, &["checkout", "--track", name, "--"])?;
    } else {
        return Err(Error::Git(format!("no branch named `{name}`")));
    }
    Ok(())
}

/// Creates a branch from HEAD and checks it out.
pub fn create_branch(cwd: &Path, name: &str) -> Result<()> {
    checked_name(cwd, name)?;
    run(cwd, &["checkout", "-b", name, "--"])?;
    Ok(())
}

/// Fast-forward only: never creates a merge or rebases.
pub fn pull(cwd: &Path) -> Result<()> {
    run(cwd, &["pull", "--ff-only"])?;
    Ok(())
}

/// Commits exactly `paths` (modified, deleted, renamed or untracked), leaving
/// everything else the user has staged, or not, as it was. A rename needs both
/// its old and new path.
pub fn commit(cwd: &Path, paths: &[String], message: &str) -> Result<()> {
    if paths.is_empty() {
        return Err(Error::Git("Select at least one file to commit.".into()));
    }
    if message.trim().is_empty() {
        return Err(Error::Git("Write a commit message.".into()));
    }
    // Pathspecs are file names, never patterns; `--` keeps them from being options.
    let mut listing = vec![
        "--literal-pathspecs",
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--",
    ];
    listing.extend(paths.iter().map(String::as_str));
    let untracked: Vec<String> = run(cwd, &listing)?
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    // `--only` commits tracked paths; a new file must be known to the index first.
    if !untracked.is_empty() {
        let mut add = vec!["--literal-pathspecs", "add", "--intent-to-add", "--"];
        add.extend(untracked.iter().map(String::as_str));
        run(cwd, &add)?;
    }
    let mut commit = vec![
        "--literal-pathspecs",
        "commit",
        "--quiet",
        "--only",
        "-m",
        message,
        "--",
    ];
    commit.extend(paths.iter().map(String::as_str));
    let result = run(cwd, &commit);
    if result.is_err() && !untracked.is_empty() {
        let mut undo = vec!["--literal-pathspecs", "reset", "--quiet", "--"];
        undo.extend(untracked.iter().map(String::as_str));
        let _ = run(cwd, &undo);
    }
    result.map(|_| ())
}

/// Pushes the current branch, setting its upstream the first time. There is
/// no force: a rejected push stays rejected. Protected branches need
/// `allow_protected`.
pub fn push(cwd: &Path, allow_protected: bool) -> Result<()> {
    let status = status(cwd)?;
    let Some(branch) = status.branch else {
        return Err(Error::Git(
            "HEAD is detached; switch to a branch to push.".into(),
        ));
    };
    if status.protected && !allow_protected {
        return Err(Error::Git(format!(
            "`{branch}` is protected; confirm pushing to it, or push a new branch instead."
        )));
    }
    if status.ahead > 0 && status.behind > 0 {
        return Err(Error::Git(
            "The branch is behind and ahead of its upstream. Pull (fast-forward) before pushing."
                .into(),
        ));
    }
    if status.upstream.is_some() {
        run(cwd, &["push"])?;
    } else {
        run(cwd, &["push", "-u", "origin", "HEAD"])?;
    }
    Ok(())
}
