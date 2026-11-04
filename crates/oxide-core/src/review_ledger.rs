//! The Review ledger: how long finished work waits between a Thread's last completed Turn and the
//! merge of its pull request, and how many review rounds that work needed. An entry holds
//! identifiers, Provider, Model, counts and the kind of work, never Transcript text (ADR-0010),
//! and no foreign key to the Thread: it outlives the Thread. Nothing here is sent anywhere.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::git::run;
use crate::git_diff::base_branch;
use crate::{Core, DiffFile, DiffScope};

/// Most recent entries a [`ReviewLedger`] lists.
pub const RECENT_ENTRIES: usize = 20;

/// Changed lines up to which a change counts as small.
const SMALL_CHANGE_LINES: u32 = 100;
/// Changed lines up to which a change counts as medium; more is large.
const MEDIUM_CHANGE_LINES: u32 = 500;

/// The band a change's diff size falls in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewSizeBand {
    Small,
    Medium,
    Large,
}

impl ReviewSizeBand {
    fn of(changed_lines: u32) -> Self {
        if changed_lines <= SMALL_CHANGE_LINES {
            Self::Small
        } else if changed_lines <= MEDIUM_CHANGE_LINES {
            Self::Medium
        } else {
            Self::Large
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "medium" => Self::Medium,
            "large" => Self::Large,
            _ => Self::Small,
        }
    }
}

/// What a review round was about: the languages its change touched, how big the diff was and,
/// when the Thread came from a GitHub issue, that issue's labels. Names and bands only.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorkKind {
    pub languages: Vec<String>,
    pub size_band: ReviewSizeBand,
    pub issue_labels: Vec<String>,
}

/// Review rounds of one Provider, Model and kind of work. The sample size is how many rounds the
/// group holds, so a small group is not read as strongly as a large one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRoundGroup {
    pub provider: String,
    pub model: Option<String>,
    pub kind: ReviewWorkKind,
    pub sample_size: u32,
}

/// The kind of work a set of changed files and issue labels describes.
fn work_kind(files: &[DiffFile], issue_labels: &[String]) -> ReviewWorkKind {
    let changed_lines = files
        .iter()
        .map(|file| file.added.saturating_add(file.removed))
        .sum();
    let mut languages: Vec<String> = files
        .iter()
        .filter_map(|file| language_of(&file.path))
        .map(str::to_string)
        .collect();
    languages.sort();
    languages.dedup();
    let mut issue_labels = issue_labels.to_vec();
    issue_labels.sort();
    issue_labels.dedup();
    ReviewWorkKind {
        languages,
        size_band: ReviewSizeBand::of(changed_lines),
        issue_labels,
    }
}

/// The language a file path names, from its extension or its well-known file name.
fn language_of(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name {
        "Dockerfile" => return Some("docker"),
        "Makefile" => return Some("makefile"),
        _ => {}
    }
    let (stem, extension) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    Some(match extension.to_ascii_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "json" => "json",
        "py" => "python",
        "sh" | "zsh" | "bash" => "shellscript",
        "md" => "markdown",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "toml" => "toml",
        "yml" | "yaml" => "yaml",
        "diff" | "patch" => "diff",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "sql" => "sql",
        "xml" => "xml",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => return None,
    })
}

fn string_list(value: &str) -> Vec<String> {
    serde_json::from_str(value).unwrap_or_default()
}

/// One merged pull request of a Thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLedgerEntry {
    pub project_id: u32,
    /// The Thread's id when it merged. The Thread itself may be gone.
    pub thread_id: u32,
    pub pull_request: u32,
    pub provider: String,
    pub model: Option<String>,
    /// When the Thread's last Turn completed, seconds since the Unix epoch (UTC).
    pub turn_completed_at: i64,
    /// When the pull request was merged, seconds since the Unix epoch (UTC).
    pub merged_at: i64,
}

impl ReviewLedgerEntry {
    /// How long the work waited, never negative.
    pub fn wait_secs(&self) -> i64 {
        (self.merged_at - self.turn_completed_at).max(0)
    }
}

/// Status of a follow-up fix candidate in the Review ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FollowUpStatus {
    Candidate,
    Confirmed,
    Dismissed,
}

impl FollowUpStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Confirmed => "confirmed",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "confirmed" => Self::Confirmed,
            "dismissed" => Self::Dismissed,
            _ => Self::Candidate,
        }
    }
}

/// A revert commit detected on the default branch for a tracked merged pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRevert {
    pub pull_request: u32,
    pub commit_sha: String,
    pub commit_subject: String,
    pub committed_at: i64,
}

/// A follow-up candidate commit detected on the default branch for a tracked merged pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFollowUp {
    pub pull_request: u32,
    pub commit_sha: String,
    pub commit_subject: String,
    pub committed_at: i64,
    pub co_modified_files: Vec<String>,
    pub status: FollowUpStatus,
}

/// A Project's figures: the median wait, the most recent entries, newest merge first, and the
/// review rounds grouped by Provider, Model and kind of work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLedger {
    /// Median wait in seconds; `None` without entries.
    pub median_secs: Option<i64>,
    /// How many entries the Project has.
    pub count: u32,
    pub entries: Vec<ReviewLedgerEntry>,
    pub rounds: Vec<ReviewRoundGroup>,
    pub reverts: Vec<ReviewRevert>,
    pub follow_ups: Vec<ReviewFollowUp>,
}

pub(crate) struct LedgerStore {
    db_path: PathBuf,
    conn: Mutex<Option<Connection>>,
}

impl LedgerStore {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            conn: Mutex::new(None),
        }
    }

    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let conn = Connection::open(&self.db_path)?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            *guard = Some(conn);
        }
        f(guard.as_ref().expect("connection opened above"))
    }

    /// Records the merge of `pull_request`, opened from the Thread's branch, at `merged_at` (an
    /// ISO 8601 UTC timestamp from GitHub). Does nothing when the Thread is gone, has no
    /// completed Turn, `merged_at` is unreadable, or the pull request is already recorded.
    pub(crate) fn record_merge(
        &self,
        thread_id: u32,
        pull_request: u32,
        merged_at: &str,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO review_ledger
                     (project_id, thread_id, pull_request, provider, model, turn_completed_at, merged_at)
                 SELECT t.project_id, t.id, ?2, t.provider, t.model,
                        (SELECT MAX(CAST(strftime('%s', u.completed_at) AS INTEGER)) FROM turns u
                          WHERE u.thread_id = t.id AND u.status = 'completed'
                            AND CAST(strftime('%s', u.completed_at) AS INTEGER) <= CAST(strftime('%s', ?3) AS INTEGER)),
                        CAST(strftime('%s', ?3) AS INTEGER)
                 FROM threads t
                 WHERE t.id = ?1
                   AND strftime('%s', ?3) IS NOT NULL
                   AND (SELECT MAX(CAST(strftime('%s', u.completed_at) AS INTEGER)) FROM turns u
                         WHERE u.thread_id = t.id AND u.status = 'completed'
                           AND CAST(strftime('%s', u.completed_at) AS INTEGER) <= CAST(strftime('%s', ?3) AS INTEGER)) IS NOT NULL",
                rusqlite::params![thread_id, pull_request, merged_at],
            )?;
            Ok(())
        })
    }

    /// Records one review round of the Thread, snapshotting its Provider, Model and kind of work.
    /// Does nothing when the Thread is gone.
    pub(crate) fn record_round(&self, thread_id: u32, kind: &ReviewWorkKind) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO review_rounds
                     (project_id, thread_id, provider, model, languages, size_band, issue_labels)
                 SELECT project_id, id, provider, model, ?2, ?3, ?4
                 FROM threads WHERE id = ?1",
                rusqlite::params![
                    thread_id,
                    serde_json::to_string(&kind.languages).unwrap_or_else(|_| "[]".into()),
                    kind.size_band.as_str(),
                    serde_json::to_string(&kind.issue_labels).unwrap_or_else(|_| "[]".into()),
                ],
            )?;
            Ok(())
        })
    }

    pub(crate) fn thread_of_branch(&self, project_id: u32, branch: &str) -> Result<Option<u32>> {
        self.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT id FROM threads WHERE project_id = ?1 AND branch = ?2 ORDER BY id DESC",
                    rusqlite::params![project_id, branch],
                    |r| r.get(0),
                )
                .optional()?)
        })
    }

    pub(crate) fn ledger(&self, project_id: u32) -> Result<ReviewLedger> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT project_id, thread_id, pull_request, provider, model, turn_completed_at, merged_at
                 FROM review_ledger WHERE project_id = ?1 ORDER BY merged_at DESC, id DESC",
            )?;
            let all = stmt
                .query_map([project_id], |r| {
                    Ok(ReviewLedgerEntry {
                        project_id: r.get(0)?,
                        thread_id: r.get(1)?,
                        pull_request: r.get(2)?,
                        provider: r.get(3)?,
                        model: r.get(4)?,
                        turn_completed_at: r.get(5)?,
                        merged_at: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let mut waits: Vec<i64> = all.iter().map(ReviewLedgerEntry::wait_secs).collect();
            waits.sort_unstable();
            let median_secs = match waits.len() {
                0 => None,
                n if n % 2 == 1 => Some(waits[n / 2]),
                n => Some((waits[n / 2 - 1] + waits[n / 2]) / 2),
            };
            let count = all.len() as u32;

            let mut stmt = conn.prepare(
                "SELECT provider, model, languages, size_band, issue_labels
                 FROM review_rounds WHERE project_id = ?1",
            )?;
            let rounds = stmt.query_map([project_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    ReviewWorkKind {
                        languages: string_list(&r.get::<_, String>(2)?),
                        size_band: ReviewSizeBand::parse(&r.get::<_, String>(3)?),
                        issue_labels: string_list(&r.get::<_, String>(4)?),
                    },
                ))
            })?;
            let mut groups: BTreeMap<(String, Option<String>, ReviewWorkKind), u32> = BTreeMap::new();
            for round in rounds {
                let (provider, model, kind) = round?;
                *groups.entry((provider, model, kind)).or_default() += 1;
            }
            let rounds = groups
                .into_iter()
                .map(|((provider, model, kind), sample_size)| ReviewRoundGroup {
                    provider,
                    model,
                    kind,
                    sample_size,
                })
                .collect();

            let mut stmt = conn.prepare(
                "SELECT pull_request, commit_sha, commit_subject, committed_at
                 FROM review_reverts WHERE project_id = ?1 ORDER BY committed_at DESC, id DESC",
            )?;
            let reverts = stmt
                .query_map([project_id], |r| {
                    Ok(ReviewRevert {
                        pull_request: r.get(0)?,
                        commit_sha: r.get(1)?,
                        commit_subject: r.get(2)?,
                        committed_at: r.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            let mut stmt = conn.prepare(
                "SELECT pull_request, commit_sha, commit_subject, committed_at, co_modified_files, status
                 FROM review_follow_ups WHERE project_id = ?1 ORDER BY committed_at DESC, id DESC",
            )?;
            let follow_ups = stmt
                .query_map([project_id], |r| {
                    Ok(ReviewFollowUp {
                        pull_request: r.get(0)?,
                        commit_sha: r.get(1)?,
                        commit_subject: r.get(2)?,
                        committed_at: r.get(3)?,
                        co_modified_files: string_list(&r.get::<_, String>(4)?),
                        status: FollowUpStatus::parse(&r.get::<_, String>(5)?),
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;

            Ok(ReviewLedger {
                median_secs,
                count,
                entries: all.into_iter().take(RECENT_ENTRIES).collect(),
                rounds,
                reverts,
                follow_ups,
            })
        })
    }

    pub(crate) fn clear(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM review_ledger", [])?;
            conn.execute("DELETE FROM review_rounds", [])?;
            conn.execute("DELETE FROM review_reverts", [])?;
            conn.execute("DELETE FROM review_follow_ups", [])?;
            Ok(())
        })
    }

    pub(crate) fn set_follow_up_status(
        &self,
        project_id: u32,
        pull_request: u32,
        commit_sha: &str,
        status: FollowUpStatus,
    ) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute(
                "UPDATE review_follow_ups SET status = ?4
                 WHERE project_id = ?1 AND pull_request = ?2 AND commit_sha = ?3",
                rusqlite::params![project_id, pull_request, commit_sha, status.as_str()],
            )?;
            Ok(())
        })
    }
}

/// 30 days in seconds: the time window within which reverts and follow-up fixes are tracked.
const THIRTY_DAYS_SECS: i64 = 30 * 86_400;

/// Whether a file path is considered boilerplate (documentation, configs, lockfiles, etc.)
/// rather than functional code.
pub(crate) fn is_boilerplate(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);

    // Markdown / text docs
    if lower.ends_with(".md")
        || lower.ends_with(".txt")
        || lower.ends_with(".rst")
        || lower.ends_with(".adoc")
    {
        return true;
    }

    // Docs directory
    if lower.starts_with("docs/") || lower.contains("/docs/") {
        return true;
    }

    // Licenses, notices, contributing, changelog
    if name.starts_with("license")
        || name.starts_with("licence")
        || name.starts_with("copying")
        || name.starts_with("notice")
        || name.starts_with("contributing")
        || name.starts_with("changelog")
        || name.starts_with("changes")
        || name.starts_with("authors")
        || name.starts_with("code_of_conduct")
        || name.starts_with("codeowners")
    {
        return true;
    }

    // Lockfiles
    if matches!(
        name,
        "cargo.lock"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "poetry.lock"
            | "gemfile.lock"
            | "composer.lock"
            | "flake.lock"
    ) {
        return true;
    }

    // Dotfiles / Tool / CI configurations
    if lower.starts_with(".github/")
        || lower.contains("/.github/")
        || lower.starts_with(".vscode/")
        || lower.contains("/.vscode/")
        || matches!(
            name,
            ".gitignore"
                | ".gitattributes"
                | ".editorconfig"
                | ".prettierrc"
                | ".prettierignore"
                | ".eslintrc"
                | ".eslintignore"
        )
    {
        return true;
    }

    false
}

/// Information about a commit on the default branch.
struct CommitInfo {
    sha: String,
    committed_at: i64,
    subject: String,
    files: Vec<String>,
}

/// Inspects git log on the default branch to detect reverts and candidate follow-up fixes
/// for tracked merged pull requests within 30 days of their merge.
pub(crate) fn detect_reverts_and_follow_ups(
    cwd: &Path,
    project_id: u32,
    store: &LedgerStore,
) -> Result<()> {
    // 1. Gather all merged PRs for this project
    let entries = store.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT pull_request, merged_at FROM review_ledger WHERE project_id = ?1")?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    if entries.is_empty() {
        return Ok(());
    }

    // Determine target ref for the default branch: symbolic-ref or base_branch or HEAD
    let default_ref = base_branch(cwd).unwrap_or_else(|| "HEAD".to_string());

    // 2. Read recent commits from default branch (up to 1000 commits)
    // Use %x1e (record separator) before each commit and %x1f (unit separator) between fields
    let log_args = [
        "log",
        "-n",
        "1000",
        "--format=%x1e%H%x1f%ct%x1f%s",
        "--name-only",
        &default_ref,
        "--",
    ];
    let log_out = match run(cwd, &log_args) {
        Ok(out) => out,
        Err(_) => return Ok(()),
    };

    let mut commits: Vec<CommitInfo> = Vec::new();
    for block in log_out.split('\x1e') {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        let (header, files_part) = match block.split_once('\n') {
            Some((h, f)) => (h.trim(), f),
            None => (block.trim(), ""),
        };
        let fields: Vec<&str> = header.split('\x1f').collect();
        if fields.len() < 3 {
            continue;
        }
        let sha = fields[0].trim().to_string();
        let committed_at = fields[1].trim().parse::<i64>().unwrap_or(0);
        let subject = fields[2].trim().to_string();
        let files = files_part
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        commits.push(CommitInfo {
            sha,
            committed_at,
            subject,
            files,
        });
    }

    // For candidate follow-up fixes, we need the files modified by each tracked PR.
    for (pr_number, merged_at) in &entries {
        let pr_number = *pr_number;
        let merged_at = *merged_at;
        let pr_marker = format!("#{pr_number}");

        // Find the PR files by looking up commits mentioning `(#<pr_number>)` or `#<pr_number>`
        let mut pr_files: HashSet<String> = HashSet::new();
        for commit in &commits {
            let lower_subj = commit.subject.to_ascii_lowercase();
            if lower_subj.contains(&pr_marker.to_ascii_lowercase())
                && !lower_subj.contains("revert")
            {
                for f in &commit.files {
                    pr_files.insert(f.clone());
                }
            }
        }

        // If no commit files were found from commits list, try querying git log for that PR specifically across all branches
        if pr_files.is_empty() {
            let pr_grep = format!("#{pr_number}");
            let pr_log = run(
                cwd,
                &[
                    "log",
                    "--all",
                    "-n",
                    "10",
                    &format!("--grep={pr_grep}"),
                    "--name-only",
                    "--format=",
                    "--",
                ],
            )
            .unwrap_or_default();
            for line in pr_log.lines() {
                let line = line.trim();
                if !line.is_empty() {
                    pr_files.insert(line.to_string());
                }
            }
        }

        for commit in &commits {
            // Heuristic 2: within 30 days after merge
            if commit.committed_at < merged_at || commit.committed_at > merged_at + THIRTY_DAYS_SECS
            {
                continue;
            }

            let lower_subj = commit.subject.to_ascii_lowercase();

            // Revert check: subject indicates revert of this PR
            // e.g. "Revert ... (#4)" or "Revert #4"
            if lower_subj.contains("revert")
                && (lower_subj.contains(&pr_marker.to_ascii_lowercase())
                    || lower_subj.contains(&format!(" #{pr_number}"))
                    || lower_subj.contains(&format!("\"#{pr_number}\"")))
            {
                let _ = store.with_conn(|conn| {
                    conn.execute(
                        "INSERT OR IGNORE INTO review_reverts
                             (project_id, pull_request, commit_sha, commit_subject, committed_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![
                            project_id,
                            pr_number,
                            commit.sha,
                            commit.subject,
                            commit.committed_at,
                        ],
                    )?;
                    Ok(())
                });
            }

            // Candidate follow-up check:
            // Must not be the merge commit of the PR itself or a revert
            if lower_subj.contains("revert")
                || (lower_subj.contains(&pr_marker.to_ascii_lowercase())
                    && commit.committed_at == merged_at)
            {
                continue;
            }

            // Heuristic 3: Co-modified files
            let mut co_modified: Vec<String> = commit
                .files
                .iter()
                .filter(|f| pr_files.contains(*f))
                .cloned()
                .collect();
            co_modified.sort();
            co_modified.dedup();

            if co_modified.is_empty() {
                continue;
            }

            // Heuristic 4: At least one co-modified file is non-boilerplate
            let has_non_boilerplate = co_modified.iter().any(|f| !is_boilerplate(f));
            if !has_non_boilerplate {
                continue;
            }

            let co_modified_json =
                serde_json::to_string(&co_modified).unwrap_or_else(|_| "[]".into());
            let _ = store.with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO review_follow_ups
                         (project_id, pull_request, commit_sha, commit_subject, committed_at, co_modified_files, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'candidate')",
                    rusqlite::params![
                        project_id,
                        pr_number,
                        commit.sha,
                        commit.subject,
                        commit.committed_at,
                        co_modified_json,
                    ],
                )?;
                Ok(())
            });
        }
    }

    Ok(())
}

impl Core {
    /// The kind of work a review round of the Thread is about: its committed branch changes
    /// merged with its uncommitted ones, and the labels of the issue it came from. `None` when
    /// the Thread is gone.
    pub(crate) fn review_work_kind(&self, thread_id: u32) -> Option<ReviewWorkKind> {
        let (project_id, issue_labels) = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let (project_id, labels) = db
                .query_row(
                    "SELECT project_id, issue_labels FROM threads WHERE id = ?1",
                    [thread_id],
                    |r| Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?)),
                )
                .ok()?;
            (project_id, string_list(&labels))
        };
        let branch = self
            .diff_in(project_id, Some(thread_id), DiffScope::Branch)
            .map(|diff| diff.files)
            .unwrap_or_default();
        let uncommitted = self
            .diff_in(project_id, Some(thread_id), DiffScope::Uncommitted)
            .map(|diff| diff.files)
            .unwrap_or_default();
        let mut by_path: BTreeMap<String, DiffFile> = BTreeMap::new();
        for file in branch.into_iter().chain(uncommitted) {
            by_path
                .entry(file.path.clone())
                .and_modify(|seen| {
                    seen.added = seen.added.saturating_add(file.added);
                    seen.removed = seen.removed.saturating_add(file.removed);
                })
                .or_insert(file);
        }
        let files: Vec<DiffFile> = by_path.into_values().collect();
        Some(work_kind(&files, &issue_labels))
    }

    /// Records the round of a Thread that just sent Line comments or reviewer comments. Best
    /// effort: the ledger is a nicety that must not turn a successful send into an error.
    pub(crate) fn record_review_round(&self, thread_id: u32, kind: &ReviewWorkKind) {
        let _ = self.ledger.record_round(thread_id, kind);
    }
}
