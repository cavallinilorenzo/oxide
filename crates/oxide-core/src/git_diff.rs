//! The Diff Surface's data: Git's own diff of a Project's main checkout,
//! parsed into files and hunks.

use crate::git::{MAX_COUNTED_BYTES, ref_exists, run};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffScope {
    /// Staged, unstaged and untracked changes against HEAD.
    Uncommitted,
    /// Commits since the merge-base with the base branch.
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// The `@@ -a,b +c,d @@` line.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    /// The previous path of a renamed file.
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub added: u32,
    pub removed: u32,
    /// Binary or too large to show; `hunks` is empty.
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// What the Branch scope compares against; `None` when no base branch exists.
    pub base: Option<String>,
    pub files: Vec<DiffFile>,
}

/// Branches tried, in order, when the remote names no default branch.
const BASE_CANDIDATES: [&str; 6] = [
    "origin/main",
    "main",
    "origin/master",
    "master",
    "origin/dev",
    "dev",
];

fn base_branch(cwd: &Path) -> Option<String> {
    run(
        cwd,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|name| ref_exists(cwd, name))
    .or_else(|| {
        BASE_CANDIDATES
            .iter()
            .find(|name| ref_exists(cwd, name))
            .map(|name| name.to_string())
    })
}

pub fn diff(cwd: &Path, scope: DiffScope) -> Result<Diff> {
    let has_head = ref_exists(cwd, "HEAD");
    match scope {
        DiffScope::Uncommitted => {
            let base = if has_head {
                "HEAD".to_string()
            } else {
                // No commits yet: diff against the empty tree.
                run(cwd, &["hash-object", "-t", "tree", "/dev/null"])?
                    .trim()
                    .to_string()
            };
            let mut files = diff_against(cwd, &[&base])?;
            files.extend(untracked_files(cwd)?);
            Ok(Diff { base: None, files })
        }
        DiffScope::Branch => {
            let none = || Diff {
                base: None,
                files: Vec::new(),
            };
            let Some(base) = base_branch(cwd).filter(|_| has_head) else {
                return Ok(none());
            };
            let Ok(fork) = run(cwd, &["merge-base", &base, "HEAD"]) else {
                // Unrelated histories: nothing shared to compare from.
                return Ok(Diff {
                    base: Some(base),
                    files: Vec::new(),
                });
            };
            let fork = fork.trim().to_string();
            Ok(Diff {
                files: diff_against(cwd, &[&fork, "HEAD"])?,
                base: Some(base),
            })
        }
    }
}

/// Tracked changes between the given revisions (one: against the working tree).
pub(crate) fn diff_against(cwd: &Path, revs: &[&str]) -> Result<Vec<DiffFile>> {
    let base_args = [
        "--no-optional-locks",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "-M",
    ];
    let build = |extra: &[&'static str]| {
        let mut args: Vec<&str> = base_args.to_vec();
        args.extend(extra);
        args.extend(revs);
        args.push("--");
        args
    };
    let names = run(cwd, &build(&["--name-status", "-z"]))?;
    let patch = run(cwd, &build(&["--no-prefix"]))?;

    let mut sections = split_patch(&patch).into_iter();
    let mut fields = names.split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(code) = fields.next() {
        let first = fields.next().unwrap_or_default();
        let (status, old_path, path) = match code.as_bytes()[0] {
            b'R' | b'C' => (
                DiffStatus::Renamed,
                Some(first.to_string()),
                fields.next().unwrap_or_default(),
            ),
            b'A' => (DiffStatus::Added, None, first),
            b'D' => (DiffStatus::Deleted, None, first),
            _ => (DiffStatus::Modified, None, first),
        };
        let (hunks, binary) = parse_hunks(sections.next().unwrap_or_default());
        let count = |kind| {
            hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| l.kind == kind)
                .count() as u32
        };
        files.push(DiffFile {
            path: path.to_string(),
            old_path,
            status,
            added: count(DiffKind::Added),
            removed: count(DiffKind::Removed),
            binary,
            hunks,
        });
    }
    Ok(files)
}

/// Files of a unified diff that did not come from our own `git diff` call,
/// such as `gh pr diff`'s, with the default `a/` and `b/` path prefixes.
pub(crate) fn parse_patch(patch: &str) -> Vec<DiffFile> {
    use rayon::prelude::*;

    split_patch(patch)
        .par_iter()
        .map(|section| {
            let header = section.lines().next().unwrap_or_default();
            let meta = |prefix: &str| {
                section
                    .lines()
                    .take_while(|l| !l.starts_with("@@"))
                    .find_map(|l| l.strip_prefix(prefix))
            };
            let side = |prefix: &str| meta(prefix).filter(|p| *p != "/dev/null");
            let old_path = meta("rename from ").map(str::to_string);
            let path = meta("rename to ")
                .or_else(|| side("+++ b/"))
                .or_else(|| side("--- a/"))
                .or_else(|| header.split_once(" b/").map(|(_, path)| path))
                .unwrap_or_default()
                .to_string();
            let status = if old_path.is_some() {
                DiffStatus::Renamed
            } else if meta("new file mode ").is_some() {
                DiffStatus::Added
            } else if meta("deleted file mode ").is_some() {
                DiffStatus::Deleted
            } else {
                DiffStatus::Modified
            };
            let (hunks, binary) = parse_hunks(section);
            let count = |kind| {
                hunks
                    .iter()
                    .flat_map(|h| &h.lines)
                    .filter(|l| l.kind == kind)
                    .count() as u32
            };
            DiffFile {
                path,
                old_path,
                status,
                added: count(DiffKind::Added),
                removed: count(DiffKind::Removed),
                binary,
                hunks,
            }
        })
        .collect()
}

/// One slice of the patch per file, in Git's order. A line starting with
/// `diff --git ` is always a file header: hunk lines are prefixed.
fn split_patch(patch: &str) -> Vec<&str> {
    let mut starts: Vec<usize> = patch
        .match_indices("diff --git ")
        .map(|(i, _)| i)
        .filter(|i| *i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .collect();
    starts.push(patch.len());
    starts.windows(2).map(|w| &patch[w[0]..w[1]]).collect()
}

fn parse_hunks(section: &str) -> (Vec<DiffHunk>, bool) {
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut binary = false;
    for line in section.lines() {
        if line.starts_with("@@") {
            hunks.push(DiffHunk {
                header: line.to_string(),
                lines: Vec::new(),
            });
            continue;
        }
        let Some(hunk) = hunks.last_mut() else {
            binary |= line.starts_with("Binary files ") || line == "GIT binary patch";
            continue;
        };
        let (kind, text) = match line.as_bytes().first() {
            Some(b'+') => (DiffKind::Added, &line[1..]),
            Some(b'-') => (DiffKind::Removed, &line[1..]),
            Some(b' ') => (DiffKind::Context, &line[1..]),
            // "\ No newline at end of file".
            _ => continue,
        };
        hunk.lines.push(DiffLine {
            kind,
            text: text.to_string(),
        });
    }
    (hunks, binary)
}

fn untracked_files(cwd: &Path) -> Result<Vec<DiffFile>> {
    use rayon::prelude::*;

    let listing = run(
        cwd,
        &[
            "--no-optional-locks",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?;
    let paths: Vec<&str> = listing.split('\0').filter(|p| !p.is_empty()).collect();
    Ok(paths
        .par_iter()
        .map(|path| {
            let text = read_text(&cwd.join(path));
            let lines: Vec<DiffLine> = text
                .as_deref()
                .map(|t| {
                    t.lines()
                        .map(|l| DiffLine {
                            kind: DiffKind::Added,
                            text: l.to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let added = lines.len() as u32;
            let hunks = if lines.is_empty() {
                Vec::new()
            } else {
                vec![DiffHunk {
                    header: format!("@@ -0,0 +1,{added} @@"),
                    lines,
                }]
            };
            DiffFile {
                path: path.to_string(),
                old_path: None,
                status: DiffStatus::Untracked,
                added,
                removed: 0,
                binary: text.is_none(),
                hunks,
            }
        })
        .collect())
}

/// A text file's content; `None` for binary, oversized, non-UTF-8 or
/// unreadable files and for symlinks, which are never read through.
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COUNTED_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len().min(MAX_COUNTED_BYTES) as usize);
    File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Which diff a revert acts on. Branch and PR scopes are history, not edits to undo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevertScope {
    /// Staged, unstaged and untracked changes against HEAD.
    Uncommitted,
    /// What a Thread's latest Turn changed between its two Checkpoints.
    Turn,
}

/// A hunk as the Diff showed it: its position and `@@` line, so a diff that has
/// changed since is refused instead of reverting a different hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertHunk {
    pub index: usize,
    pub header: String,
}

/// A file, or one hunk of it, to take out of a diff.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertTarget {
    pub path: String,
    pub hunk: Option<RevertHunk>,
}

/// Undoes `target` in the working tree by applying its patch in reverse. The
/// patch is checked first, so one that does not apply cleanly changes nothing.
/// `revs` are the revisions the diff was taken between (one: against the working tree).
pub(crate) fn revert(
    cwd: &Path,
    revs: &[&str],
    include_untracked: bool,
    target: &RevertTarget,
    confirm_delete: bool,
) -> Result<()> {
    let path = target.path.as_str();
    let mut files = diff_against(cwd, revs)?;
    if include_untracked {
        files.extend(untracked_files(cwd)?);
    }
    let Some(file) = files.iter().find(|f| f.path == path) else {
        return Err(Error::Git(format!(
            "{path} has no changes to revert any more."
        )));
    };
    if matches!(file.status, DiffStatus::Added | DiffStatus::Untracked) && !confirm_delete {
        return Err(Error::Git(format!(
            "Reverting {path} deletes the file. Confirm to continue."
        )));
    }
    if let Some(hunk) = &target.hunk
        && file.hunks.get(hunk.index).map(|h| h.header.as_str()) != Some(hunk.header.as_str())
    {
        return Err(Error::Git(format!(
            "The changes in {path} moved on since they were shown. Nothing was reverted."
        )));
    }
    if file.status == DiffStatus::Untracked {
        // `path` came from Git's own listing, so it stays inside the checkout.
        return std::fs::remove_file(cwd.join(path))
            .map_err(|e| Error::Git(format!("Could not delete {path}: {e}")));
    }

    // A file named like a glob or pathspec magic must match only itself.
    let mut args = vec![
        "--literal-pathspecs",
        "--no-optional-locks",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--binary",
        "-M",
    ];
    args.extend(revs);
    args.extend(["--", path]);
    if let Some(old) = file.old_path.as_deref() {
        args.push(old);
    }
    let mut patch = run(cwd, &args)?;
    if let Some(hunk) = &target.hunk {
        patch = single_hunk(&patch, hunk.index)
            .ok_or_else(|| Error::Git(format!("Could not find that hunk of {path}.")))?;
    }

    let git_dir = std::path::PathBuf::from(run(cwd, &["rev-parse", "--absolute-git-dir"])?.trim());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let patch_file = git_dir.join(format!("oxide-revert-{}-{nanos}.patch", std::process::id()));
    std::fs::write(&patch_file, patch).map_err(|e| Error::Git(format!("Could not revert: {e}")))?;
    let patch_arg = patch_file.to_string_lossy().into_owned();
    let applied = run(
        cwd,
        &["apply", "-R", "--check", "--whitespace=nowarn", &patch_arg],
    )
    .and_then(|_| run(cwd, &["apply", "-R", "--whitespace=nowarn", &patch_arg]));
    let _ = std::fs::remove_file(&patch_file);
    applied.map_err(|e| {
        Error::Git(format!(
            "Could not revert {path}: the file no longer matches this change. Nothing was reverted. ({e})"
        ))
    })?;

    // A file the change added is gone from the working tree; drop it from the
    // index too, so it does not linger as a staged addition.
    if !cwd.join(path).exists() && run(cwd, &["cat-file", "-e", &format!("HEAD:{path}")]).is_err() {
        run(
            cwd,
            &["rm", "-q", "--cached", "--ignore-unmatch", "--", path],
        )?;
    }
    Ok(())
}

/// The file header of a one-file patch with only its `index`th hunk.
fn single_hunk(patch: &str, index: usize) -> Option<String> {
    let mut header = String::new();
    let mut hunk = String::new();
    let mut seen = 0usize;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@") {
            seen += 1;
        }
        match seen {
            0 => header.push_str(line),
            n if n == index + 1 => hunk.push_str(line),
            _ => {}
        }
    }
    (!hunk.is_empty()).then(|| header + &hunk)
}
