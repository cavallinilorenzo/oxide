//! Line comments: drafts on one line of a Diff, kept per Thread until they are sent to it in one
//! prompt, or per pull request until they are sent to GitHub in one review.

use crate::thread::ThreadStatus;
use crate::{Core, DiffKind, DiffScope, Error, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommentScope {
    Turn,
    Uncommitted,
    Branch,
}

impl CommentScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Uncommitted => "uncommitted",
            Self::Branch => "branch",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "turn" => Self::Turn,
            "branch" => Self::Branch,
            _ => Self::Uncommitted,
        }
    }
}

/// Which side of the Diff the line is on: `Old` for a removed line, `New` for an added or
/// unchanged one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommentSide {
    Old,
    New,
}

impl CommentSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Old => "old",
            Self::New => "new",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "old" { Self::Old } else { Self::New }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewLineComment {
    pub scope: CommentScope,
    pub path: String,
    pub side: CommentSide,
    /// 1-based line number on that side.
    pub line: u32,
    /// The code of the line, quoted as it was when commenting.
    pub code: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineComment {
    pub id: u32,
    pub thread_id: u32,
    pub scope: CommentScope,
    pub path: String,
    pub side: CommentSide,
    pub line: u32,
    pub code: String,
    pub body: String,
    /// The line no longer holds the quoted code.
    pub outdated: bool,
}

/// A new draft Line comment on a pull request's Diff, before any review is submitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequestLineComment {
    pub path: String,
    pub side: CommentSide,
    /// 1-based line number on that side of the pull request's diff.
    pub line: u32,
    /// The code of the line, quoted as it was when commenting.
    pub code: String,
    pub body: String,
}

/// A draft Line comment on a pull request's Diff. It belongs to the Project and the pull request,
/// never to a checkout, and stays a draft until a review is submitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLineComment {
    pub id: u32,
    pub project_id: u32,
    pub pull_request: u32,
    pub path: String,
    pub side: CommentSide,
    pub line: u32,
    pub code: String,
    pub body: String,
}

/// The prompt that delivers drafts: file, line, quoted code and comment for each.
pub(crate) fn prompt(comments: &[LineComment]) -> String {
    let mut out = format!(
        "I reviewed your changes and left {} comment{}. Please address each one.\n",
        comments.len(),
        if comments.len() == 1 { "" } else { "s" }
    );
    for c in comments {
        let side = match c.side {
            CommentSide::Old => " (removed line)",
            CommentSide::New => "",
        };
        // A fence longer than any backtick run in the code keeps the quote intact.
        let longest = c
            .code
            .split(|ch| ch != '`')
            .map(str::len)
            .max()
            .unwrap_or(0);
        let fence = "`".repeat((longest + 1).max(3));
        out.push_str(&format!(
            "\n### {}:{}{}\n{fence}\n{}\n{fence}\n{}\n",
            c.path, c.line, side, c.code, c.body
        ));
    }
    out
}

impl Core {
    pub fn add_line_comment(&self, thread_id: u32, new: NewLineComment) -> Result<LineComment> {
        if new.body.trim().is_empty() {
            return Err(Error::Editor("A comment can't be empty.".into()));
        }
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "INSERT INTO line_comments (thread_id, scope, path, side, line, code, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                thread_id,
                new.scope.as_str(),
                new.path,
                new.side.as_str(),
                new.line,
                new.code,
                new.body
            ],
        )?;
        let id = db.last_insert_rowid() as u32;
        Ok(LineComment {
            id,
            thread_id,
            scope: new.scope,
            path: new.path,
            side: new.side,
            line: new.line,
            code: new.code,
            body: new.body,
            outdated: false,
        })
    }

    pub fn edit_line_comment(&self, id: u32, body: &str) -> Result<()> {
        if body.trim().is_empty() {
            return Err(Error::Editor("A comment can't be empty.".into()));
        }
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "UPDATE line_comments SET body = ?1 WHERE id = ?2",
            rusqlite::params![body, id],
        )?;
        Ok(())
    }

    pub fn delete_line_comment(&self, id: u32) -> Result<()> {
        self.db
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute("DELETE FROM line_comments WHERE id = ?1", [id])?;
        Ok(())
    }

    /// A Thread's drafts, oldest first, each flagged when its line no longer holds the quoted code.
    pub fn list_line_comments(&self, thread_id: u32) -> Result<Vec<LineComment>> {
        let mut comments: Vec<LineComment> = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let mut stmt = db.prepare(
                "SELECT id, scope, path, side, line, code, body FROM line_comments
                 WHERE thread_id = ?1 ORDER BY id",
            )?;
            stmt.query_map([thread_id], |r| {
                Ok(LineComment {
                    id: r.get(0)?,
                    thread_id,
                    scope: CommentScope::parse(&r.get::<_, String>(1)?),
                    path: r.get(2)?,
                    side: CommentSide::parse(&r.get::<_, String>(3)?),
                    line: r.get(4)?,
                    code: r.get(5)?,
                    body: r.get(6)?,
                    outdated: false,
                })
            })?
            .collect::<std::result::Result<_, _>>()?
        };
        if comments.is_empty() {
            return Ok(comments);
        }
        let project_id = self.storage.get_snapshot(thread_id, 0)?.thread.project_id;
        let root = PathBuf::from(self.checkout_path(project_id, Some(thread_id))?);
        let mut diffs = std::collections::HashMap::new();
        for c in &mut comments {
            c.outdated = match c.side {
                CommentSide::New => !std::fs::read_to_string(root.join(&c.path))
                    .map(|text| {
                        text.lines().nth(c.line as usize - 1).map(str::to_owned)
                            == Some(c.code.clone())
                    })
                    .unwrap_or(false),
                CommentSide::Old => {
                    let scope = c.scope;
                    let diff = diffs.entry(scope.as_str()).or_insert_with(|| match scope {
                        CommentScope::Turn => self.latest_turn_diff(thread_id).ok(),
                        CommentScope::Uncommitted => self
                            .diff_in(project_id, Some(thread_id), DiffScope::Uncommitted)
                            .ok(),
                        CommentScope::Branch => self
                            .diff_in(project_id, Some(thread_id), DiffScope::Branch)
                            .ok(),
                    });
                    // A diff that can't be computed says nothing against the draft.
                    diff.as_ref().is_some_and(|d| {
                        !d.files.iter().any(|f| {
                            f.path == c.path
                                && f.hunks
                                    .iter()
                                    .flat_map(|h| &h.lines)
                                    .any(|l| l.kind == DiffKind::Removed && l.text == c.code)
                        })
                    })
                }
            };
        }
        Ok(comments)
    }

    /// Delivers every draft of the Thread as one prompt, then clears them. Refused while the
    /// Thread is working, so the drafts are not lost into a running Turn.
    pub fn send_line_comments(&self, thread_id: u32) -> Result<()> {
        if self.storage.get_snapshot(thread_id, 0)?.thread.status == ThreadStatus::Working {
            return Err(Error::Editor(
                "This Thread is working. Send the comments when it has finished.".into(),
            ));
        }
        let comments = self.list_line_comments(thread_id)?;
        if comments.is_empty() {
            return Err(Error::Editor("There are no comments to send.".into()));
        }
        let kind = self.review_work_kind(thread_id);
        self.send_prompt(thread_id, &prompt(&comments))?;
        if let Some(kind) = kind {
            self.record_review_round(thread_id, &kind);
        }
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        for c in &comments {
            db.execute("DELETE FROM line_comments WHERE id = ?1", [c.id])?;
        }
        Ok(())
    }

    /// Delivers a request that addresses selected reviewer comments as one prompt, and counts it
    /// as a review round. The caller builds the prompt, including how reviewer text is delimited
    /// as external content.
    pub fn send_reviewer_comments(&self, thread_id: u32, prompt: &str) -> Result<()> {
        let kind = self.review_work_kind(thread_id);
        self.send_prompt(thread_id, prompt)?;
        if let Some(kind) = kind {
            self.record_review_round(thread_id, &kind);
        }
        Ok(())
    }

    /// Adds a draft Line comment on a pull request's Diff.
    pub fn add_pull_request_line_comment(
        &self,
        project_id: u32,
        pull_request: u32,
        new: NewPullRequestLineComment,
    ) -> Result<PullRequestLineComment> {
        if new.body.trim().is_empty() {
            return Err(Error::Editor("A comment can't be empty.".into()));
        }
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "INSERT INTO pull_request_line_comments
             (project_id, pull_request, path, side, line, code, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                project_id,
                pull_request,
                new.path,
                new.side.as_str(),
                new.line,
                new.code,
                new.body
            ],
        )?;
        Ok(PullRequestLineComment {
            id: db.last_insert_rowid() as u32,
            project_id,
            pull_request,
            path: new.path,
            side: new.side,
            line: new.line,
            code: new.code,
            body: new.body,
        })
    }

    pub fn edit_pull_request_line_comment(&self, id: u32, body: &str) -> Result<()> {
        if body.trim().is_empty() {
            return Err(Error::Editor("A comment can't be empty.".into()));
        }
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "UPDATE pull_request_line_comments SET body = ?1 WHERE id = ?2",
            rusqlite::params![body, id],
        )?;
        Ok(())
    }

    pub fn delete_pull_request_line_comment(&self, id: u32) -> Result<()> {
        self.db
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute("DELETE FROM pull_request_line_comments WHERE id = ?1", [id])?;
        Ok(())
    }

    /// The pull request's drafts, oldest first. They are local until a review is submitted.
    pub fn list_pull_request_line_comments(
        &self,
        project_id: u32,
        pull_request: u32,
    ) -> Result<Vec<PullRequestLineComment>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT id, path, side, line, code, body FROM pull_request_line_comments
             WHERE project_id = ?1 AND pull_request = ?2 ORDER BY id",
        )?;
        let comments = stmt
            .query_map([project_id, pull_request], |r| {
                Ok(PullRequestLineComment {
                    id: r.get(0)?,
                    project_id,
                    pull_request,
                    path: r.get(1)?,
                    side: CommentSide::parse(&r.get::<_, String>(2)?),
                    line: r.get(3)?,
                    code: r.get(4)?,
                    body: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(comments)
    }

    /// Forgets every draft of a pull request, once GitHub has taken them as one review.
    pub(crate) fn clear_pull_request_line_comments(
        &self,
        project_id: u32,
        pull_request: u32,
    ) -> Result<()> {
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "DELETE FROM pull_request_line_comments WHERE project_id = ?1 AND pull_request = ?2",
            [project_id, pull_request],
        )?;
        Ok(())
    }
}
