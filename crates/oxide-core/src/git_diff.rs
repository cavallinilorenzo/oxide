//! The Diff Surface's data: Git's own diff of a Project's main checkout,
//! parsed into files and hunks.

use crate::Result;
use crate::git::{MAX_COUNTED_BYTES, ref_exists, run};
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
    Ok(listing
        .split('\0')
        .filter(|p| !p.is_empty())
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
    let mut bytes = Vec::new();
    File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}
