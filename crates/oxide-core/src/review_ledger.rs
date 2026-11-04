//! The Review ledger: how long finished work waits between a Thread's last completed Turn and the
//! merge of its pull request, and how many review rounds that work needed. An entry holds
//! identifiers, Provider, Model, counts and the kind of work, never Transcript text (ADR-0010),
//! and no foreign key to the Thread: it outlives the Thread. Nothing here is sent anywhere.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;
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

            Ok(ReviewLedger {
                median_secs,
                count,
                entries: all.into_iter().take(RECENT_ENTRIES).collect(),
                rounds,
            })
        })
    }

    pub(crate) fn clear(&self) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute("DELETE FROM review_ledger", [])?;
            conn.execute("DELETE FROM review_rounds", [])?;
            Ok(())
        })
    }
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
