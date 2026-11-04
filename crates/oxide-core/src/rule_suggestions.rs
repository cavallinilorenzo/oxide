//! Rule suggestions: when the user keeps giving the same feedback as Line comments across
//! Threads, Oxide proposes turning it into a rule for the Project's agent instructions. Detection
//! is deterministic and local: it groups the text of sent Line comments by normalized word
//! similarity, per Project, and reads nothing but what was kept for this purpose. The Review
//! ledger still holds no comment text (ADR-0010).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::write_transaction;
use crate::line_comments::{LineComment, fenced};
use crate::{Core, Error, Result, ThreadSummary};

/// How many similar comments make a suggestion.
const MIN_RECURRING_COMMENTS: usize = 3;

/// A pattern is feedback repeated across Threads, not three notes about one review.
const MIN_RECURRING_THREADS: usize = 2;

/// The share of two comments' words they must have in common to count as the same feedback.
/// Word sets rather than edit distance, so punctuation, case and word order do not matter.
const SIMILARITY_THRESHOLD: f64 = 0.6;

/// The file a proposed rule goes in: the Project's agent instructions.
const AGENT_INSTRUCTIONS: &str = "AGENTS.md";

/// Where a rule suggestion stands. Only `Open` ones are offered; an accepted or dismissed one
/// never comes back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SuggestionStatus {
    Open,
    Accepted,
    Dismissed,
}

impl SuggestionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Accepted => "accepted",
            Self::Dismissed => "dismissed",
        }
    }
}

/// One recurring pattern of feedback, with the comments it is based on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSuggestion {
    pub id: u32,
    pub project_id: u32,
    /// The comments it is based on, oldest first.
    pub comments: Vec<String>,
}

/// The words of a comment: lowercase alphanumeric runs, so punctuation, case and spacing do not
/// make two ways of saying the same thing look different.
fn words(text: &str) -> HashSet<String> {
    text.split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// How much of two comments' vocabulary they share, from 0 to 1 (Jaccard over word sets).
fn similarity(a: &str, b: &str) -> f64 {
    let a = words(a);
    let b = words(b);
    let shared = a.intersection(&b).count();
    if shared == 0 {
        return 0.0;
    }
    shared as f64 / (a.len() + b.len() - shared) as f64
}

/// Whether a comment says what the suggestion's first comment said. Comparing every new comment
/// with that one anchor keeps a chain of loose matches from being read as one pattern.
fn recurring(anchor: &str, body: &str) -> bool {
    similarity(anchor, body) >= SIMILARITY_THRESHOLD
}

/// The prompt that hands the recurring comments to a new Thread and asks it to propose the rule.
pub(crate) fn prompt(comments: &[String]) -> String {
    let mut out = format!(
        "I keep leaving the same review feedback on changes in this Project. Please turn it into \
         a rule for the Project's agent instructions, then make the edit.\n\
         \nWrite or update {AGENT_INSTRUCTIONS} at the repository root with a short, concrete rule \
         that would stop this feedback from recurring. Change nothing else: I'll review the \
         change like any other.\n\
         \nThe recurring comments:\n"
    );
    for (index, body) in comments.iter().enumerate() {
        out.push_str(&format!("\n### Comment {}\n{}\n", index + 1, fenced(body)));
    }
    out
}

impl Core {
    /// Keeps the bodies of the Line comments just sent, in the Project's rule suggestions.
    /// Best effort: sending must not fail because a suggestion was not recorded.
    ///
    /// Each body joins an open or dismissed suggestion whose first comment it resembles, or starts
    /// one of its own. An accepted suggestion takes no more comments: feedback that returns after
    /// the rule was proposed deserves a fresh suggestion.
    pub(crate) fn remember_line_comments(
        &self,
        project_id: u32,
        thread_id: u32,
        comments: &[LineComment],
    ) {
        let _ = self.remember_comment_bodies(project_id, thread_id, comments);
    }

    fn remember_comment_bodies(
        &self,
        project_id: u32,
        thread_id: u32,
        line_comments: &[LineComment],
    ) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = write_transaction(&db)?;

        // Every suggestion's comments, oldest first; the first is the one new feedback must match.
        let mut comments: BTreeMap<u32, Vec<String>> = BTreeMap::new();
        {
            let mut stmt = tx.prepare(
                "SELECT s.id, c.body FROM rule_suggestions s
                 JOIN rule_suggestion_comments c ON c.suggestion_id = s.id
                 WHERE s.project_id = ?1 AND s.status != 'accepted' ORDER BY s.id, c.id",
            )?;
            let rows = stmt.query_map([project_id], |r| {
                Ok((r.get::<_, u32>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (suggestion_id, body) = row?;
                comments.entry(suggestion_id).or_default().push(body);
            }
        }

        for body in line_comments.iter().map(|comment| comment.body.as_str()) {
            let suggestion = comments
                .iter()
                .find(|(_, known)| known.first().is_some_and(|anchor| recurring(anchor, body)))
                .map(|(id, _)| *id);
            let suggestion = match suggestion {
                Some(id) => id,
                None => {
                    tx.execute(
                        "INSERT INTO rule_suggestions (project_id) VALUES (?1)",
                        [project_id],
                    )?;
                    let id = tx.last_insert_rowid() as u32;
                    comments.insert(id, Vec::new());
                    id
                }
            };
            tx.execute(
                "INSERT INTO rule_suggestion_comments (suggestion_id, thread_id, body)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![suggestion, thread_id, body],
            )?;
            comments
                .entry(suggestion)
                .or_default()
                .push(body.to_string());
        }

        tx.commit()?;
        Ok(())
    }

    /// The Project's open rule suggestions, oldest first: at least [`MIN_RECURRING_COMMENTS`]
    /// similar comments from at least [`MIN_RECURRING_THREADS`] Threads, with the comments they
    /// are based on.
    pub fn rule_suggestions(&self, project_id: u32) -> Result<Vec<RuleSuggestion>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT s.id, c.thread_id, c.body FROM rule_suggestions s
             JOIN rule_suggestion_comments c ON c.suggestion_id = s.id
             WHERE s.project_id = ?1 AND s.status = 'open'
             ORDER BY s.id, c.id",
        )?;
        let rows = stmt.query_map([project_id], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut suggestions: BTreeMap<u32, Vec<(u32, String)>> = BTreeMap::new();
        for row in rows {
            let (id, thread_id, body) = row?;
            suggestions.entry(id).or_default().push((thread_id, body));
        }
        Ok(suggestions
            .into_iter()
            .filter(|(_, comments)| {
                let threads: HashSet<u32> =
                    comments.iter().map(|(thread_id, _)| *thread_id).collect();
                comments.len() >= MIN_RECURRING_COMMENTS && threads.len() >= MIN_RECURRING_THREADS
            })
            .map(|(id, comments)| RuleSuggestion {
                id,
                project_id,
                comments: comments.into_iter().map(|(_, body)| body).collect(),
            })
            .collect())
    }

    /// Dismisses a suggestion for good: the same feedback never suggests a rule again.
    pub fn dismiss_rule_suggestion(&self, project_id: u32, id: u32) -> Result<()> {
        if !self.decide_rule_suggestion(project_id, id, SuggestionStatus::Dismissed)? {
            return Err(Error::Editor(
                "This rule suggestion is no longer available.".into(),
            ));
        }
        Ok(())
    }

    /// Accepts a suggestion: starts a Thread that proposes the rule in the Project's agent
    /// instructions. Nothing is written or committed here; the Thread's change is reviewed like
    /// any other.
    pub fn accept_rule_suggestion(
        &self,
        project_id: u32,
        id: u32,
        provider: &str,
    ) -> Result<ThreadSummary> {
        let comments = self
            .rule_suggestions(project_id)?
            .into_iter()
            .find(|suggestion| suggestion.id == id)
            .map(|suggestion| suggestion.comments)
            .ok_or_else(|| Error::Editor("This rule suggestion is no longer available.".into()))?;
        // Claim it before starting a Thread, so two accepts cannot both propose the same rule.
        if !self.decide_rule_suggestion(project_id, id, SuggestionStatus::Accepted)? {
            return Err(Error::Editor(
                "This rule suggestion is no longer available.".into(),
            ));
        }
        let started = match self.create_thread(project_id, provider, None, None, None) {
            Ok(thread) => match self.send_prompt(thread.id, &prompt(&comments)) {
                Ok(()) => Ok(thread),
                // Leave no empty Thread behind a proposal that never went out.
                Err(error) => {
                    let _ = self.delete_thread(thread.id, true);
                    Err(error)
                }
            },
            Err(error) => Err(error),
        };
        if started.is_err() {
            // The user may try again.
            let _ = self.decide_rule_suggestion(project_id, id, SuggestionStatus::Open);
        }
        started
    }

    /// Moves an open suggestion to `status`; false when it was already decided or is not there.
    fn decide_rule_suggestion(
        &self,
        project_id: u32,
        id: u32,
        status: SuggestionStatus,
    ) -> Result<bool> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let changed = db.execute(
            "UPDATE rule_suggestions
             SET status = ?1, decided_at = CASE WHEN ?1 = 'open' THEN NULL
                                                ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
             WHERE id = ?2 AND project_id = ?3
               AND (?1 = 'open' OR status = 'open')",
            rusqlite::params![status.as_str(), id, project_id],
        )?;
        Ok(changed == 1)
    }

    /// Forgets every comment kept to suggest rules, and the suggestions themselves. Called when
    /// the user clears the local review data.
    pub(crate) fn clear_rule_feedback(&self) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = write_transaction(&db)?;
        tx.execute("DELETE FROM rule_suggestion_comments", [])?;
        tx.execute("DELETE FROM rule_suggestions", [])?;
        tx.commit()?;
        Ok(())
    }
}
