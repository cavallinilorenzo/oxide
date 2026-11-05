//! Blind review: a review of a change by another installed Provider that receives only the
//! diff and the issue, with no Transcript content, in a detached worktree at the reviewed state
//! where it cannot touch the user's checkout.

use crate::checkpoint;
use crate::git;
use crate::git_diff::{self, DiffKind};
use crate::line_comments::{CommentScope, CommentSide, LineComment};
use crate::thread::{ThreadStatus, ThreadSummary};
use crate::worktree::{free_name, slugify};
use crate::{Core, Error, PermissionMode, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewProviderOption {
    pub provider: String,
    pub name: String,
    pub same_provider: bool,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewRequest {
    pub project_id: u32,
    pub thread_id: Option<u32>,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub scope: String,
    #[serde(default)]
    pub turn_index: Option<u32>,
    #[serde(default)]
    pub issue: Option<String>,
}

/// What the reviewer decided about one finding. Only a kept finding becomes a draft Line comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingDecision {
    Pending,
    Kept,
    Dismissed,
}

impl FindingDecision {
    fn parse(s: &str) -> Self {
        match s {
            "kept" => Self::Kept,
            "dismissed" => Self::Dismissed,
            _ => Self::Pending,
        }
    }
}

/// One finding of a Blind review. A finding that Oxide could not anchor to the reviewed Diff is
/// kept as plain text, never dropped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewFinding {
    pub id: u32,
    pub review_thread_id: u32,
    /// The reviewing Provider, so the finding is never mistaken for the user's own comment.
    pub provider: String,
    /// The line the finding is about; `None` when it could not be anchored.
    pub path: Option<String>,
    pub side: Option<CommentSide>,
    pub line: Option<u32>,
    /// The quoted code of the anchored line; empty for a plain-text finding.
    pub code: String,
    /// The finding's text, or the reply that could not be parsed.
    pub body: String,
    /// The finding could not be anchored to the reviewed Diff and is shown as plain text.
    pub plain: bool,
    pub decision: FindingDecision,
}

/// Who reviewed a change and how many of their findings were kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlindReviewSummary {
    pub review_thread_id: u32,
    pub provider: String,
    pub findings: u32,
    pub kept: u32,
}

/// Builds the prompt for a Blind review: only the diff, the issue, and the required output
/// format, with diff and issue delimited as data; no Transcript content is included.
pub fn build_blind_review_prompt(issue_text: Option<&str>, diff_text: &str) -> String {
    let issue_content = issue_text
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("No issue description provided.");
    format!(
        "Please review the following code changes against the issue specification. Do not modify any files.\n\
         Provide your findings in the following JSON format:\n\
         ```json\n\
         [\n  {{\n    \"path\": \"path/to/file\",\n    \"line\": 1,\n    \"body\": \"Comment explaining the finding\"\n  }}\n]\n\
         ```\n\
         If there are no findings, reply with an empty array `[]`.\n\n\
         <issue>\n\
         {issue_content}\n\
         </issue>\n\n\
         <diff>\n\
         {diff_text}\n\
         </diff>"
    )
}

fn is_same_provider(a: &str, b: &str) -> bool {
    a == b || (a == "antigravity" && b == "agy") || (a == "agy" && b == "antigravity")
}

fn provider_display_name(id: &str) -> &str {
    match id {
        "claude" => "Claude",
        "codex" => "Codex",
        "agy" | "antigravity" => "Antigravity",
        "fake" => "Fake",
        other => other,
    }
}

impl Core {
    /// Whether a Provider can honour a non-writing configuration.
    pub fn provider_can_honour_non_writing(&self, provider: &str) -> bool {
        let caps = self.get_provider_capabilities(provider);
        caps.supported_permission_modes
            .contains(&PermissionMode::Ask)
    }

    /// The installed Providers that can honour a non-writing configuration.
    /// With a single Provider, a fresh session is allowed and clearly labelled as the same Provider.
    pub fn blind_review_providers(
        &self,
        current_provider: Option<&str>,
    ) -> Vec<BlindReviewProviderOption> {
        let candidates = ["claude", "codex", "agy", "fake"];
        let mut eligible = Vec::new();

        for &id in &candidates {
            let det = self.detect_provider(id);
            if (det.installed || det.available) && self.provider_can_honour_non_writing(id) {
                eligible.push(id);
            }
        }

        let is_single = eligible.len() == 1;

        eligible
            .into_iter()
            .map(|id| {
                let is_same = current_provider.is_some_and(|cp| is_same_provider(cp, id));
                let name = provider_display_name(id);
                let label = if is_same || is_single {
                    format!("{name} (same provider)")
                } else {
                    name.to_string()
                };
                BlindReviewProviderOption {
                    provider: id.to_string(),
                    name: name.to_string(),
                    same_provider: is_same,
                    label,
                }
            })
            .collect()
    }

    /// Creates a worktree detached at `commit_ish` under `home/worktrees/<project-slug>/`.
    pub(crate) fn create_detached_worktree(
        &self,
        root: &Path,
        project_name: &str,
        commit_ish: &str,
        slug: &str,
    ) -> Result<PathBuf> {
        let parent = self
            .home
            .join("worktrees")
            .join(slugify(project_name, "project"));
        std::fs::create_dir_all(&parent).map_err(|source| Error::Io {
            path: parent.clone(),
            source,
        })?;
        let worktree = self.git.mutate(root, || {
            let name = free_name(root, &parent, slug);
            let worktree = parent.join(&name);
            git::run(
                root,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    "-q",
                    &worktree.to_string_lossy(),
                    commit_ish,
                ],
            )?;
            Ok(worktree)
        })?;
        Ok(worktree)
    }

    /// Creates the Thread and detached worktree for a Blind review, builds its prompt, but does
    /// not send the prompt yet.
    pub fn create_blind_review_thread(
        &self,
        request: BlindReviewRequest,
    ) -> Result<(ThreadSummary, String)> {
        if !self.provider_can_honour_non_writing(&request.provider) {
            return Err(Error::Provider(format!(
                "Provider '{}' cannot honour a non-writing configuration",
                request.provider
            )));
        }

        let (root, project_name) = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let (path, name): (String, String) = db.query_row(
                "SELECT path, name FROM projects WHERE id = ?1",
                [request.project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            (PathBuf::from(path), name)
        };

        let checkout = if let Some(tid) = request.thread_id {
            PathBuf::from(self.checkout_path(request.project_id, Some(tid))?)
        } else {
            root.clone()
        };

        let (diff_text, commit_ish) = match request.scope.as_str() {
            "turn" => {
                let tid = request
                    .thread_id
                    .ok_or_else(|| Error::Git("A Thread is required for Turn diff".into()))?;
                let turn_idx = match request.turn_index {
                    Some(idx) => idx,
                    None => {
                        let snapshot = self.storage.get_snapshot(tid, u32::MAX)?;
                        snapshot.turns.last().map(|t| t.turn_index).unwrap_or(0)
                    }
                };

                if let Some((start, end)) = checkpoint::turn_revs(&checkout, tid, turn_idx)? {
                    let diff = git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &start,
                            &end,
                            "--",
                        ],
                    )?;
                    (diff, end)
                } else {
                    let commit = git::run(&checkout, &["rev-parse", "HEAD"])?
                        .trim()
                        .to_string();
                    ("(No diff)".to_string(), commit)
                }
            }
            "branch" => {
                let base = git_diff::base_branch(&checkout).unwrap_or_else(|| "main".to_string());
                let fork = git::run(&checkout, &["merge-base", &base, "HEAD"])
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let commit = git::run(&checkout, &["rev-parse", "HEAD"])?
                    .trim()
                    .to_string();
                let diff = if !fork.is_empty() {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &fork,
                            "HEAD",
                            "--",
                        ],
                    )?
                } else {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &base,
                            "HEAD",
                            "--",
                        ],
                    )
                    .unwrap_or_default()
                };
                (diff, commit)
            }
            _ => {
                // Uncommitted scope (default)
                let has_head = git::run(&checkout, &["rev-parse", "--verify", "HEAD"]).is_ok();
                let commit = if has_head {
                    checkpoint::snapshot(&checkout).unwrap_or_else(|_| {
                        git::run(&checkout, &["rev-parse", "HEAD"])
                            .unwrap_or_default()
                            .trim()
                            .to_string()
                    })
                } else {
                    checkpoint::snapshot(&checkout)?
                };
                let diff = if has_head {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            "HEAD",
                            &commit,
                            "--",
                        ],
                    )
                    .unwrap_or_else(|_| {
                        git::run(
                            &checkout,
                            &[
                                "--no-optional-locks",
                                "diff",
                                "--no-color",
                                "--no-ext-diff",
                                "HEAD",
                                "--",
                            ],
                        )
                        .unwrap_or_default()
                    })
                } else {
                    git::run(
                        &checkout,
                        &[
                            "--no-optional-locks",
                            "diff",
                            "--no-color",
                            "--no-ext-diff",
                            &commit,
                            "--",
                        ],
                    )
                    .unwrap_or_default()
                };
                (diff, commit)
            }
        };

        let issue_text = if let Some(explicit) = request.issue.filter(|s| !s.trim().is_empty()) {
            explicit
        } else if let Some(tid) = request.thread_id {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let issue_row: Option<(Option<u32>, Option<String>, Option<String>)> = db
                .query_row(
                    "SELECT issue_number, issue_title, issue_url FROM threads WHERE id = ?1",
                    [tid],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            if let Some((Some(n), title, url)) = issue_row {
                let t = title.unwrap_or_default();
                let u = url.unwrap_or_default();
                format!("Issue #{n}: {t}\n{u}")
            } else {
                "No issue description provided.".to_string()
            }
        } else {
            "No issue description provided.".to_string()
        };

        let prompt = build_blind_review_prompt(Some(&issue_text), &diff_text);

        let worktree_path =
            self.create_detached_worktree(&root, &project_name, &commit_ish, "blind-review")?;

        let cur_provider = request.thread_id.and_then(|tid| {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row("SELECT provider FROM threads WHERE id = ?1", [tid], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        });
        let is_same = cur_provider
            .as_deref()
            .is_some_and(|cp| is_same_provider(cp, &request.provider));
        let provider_display = provider_display_name(&request.provider);
        let title = if is_same {
            format!("Blind review ({provider_display} · same provider)")
        } else {
            format!("Blind review ({provider_display})")
        };

        let (def_model, def_effort, _) = self.default_settings_for_provider(&request.provider);
        let model = request.model.or(def_model);
        let effort = request.effort.or(def_effort);

        let thread_id = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "INSERT INTO threads (project_id, provider, model, effort, permission_mode, status, title, worktree_path, blind_review, blind_review_of)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, 1, ?8)",
                rusqlite::params![
                    request.project_id,
                    request.provider,
                    model,
                    effort,
                    PermissionMode::Ask.as_str(),
                    title,
                    worktree_path.to_string_lossy(),
                    request.thread_id,
                ],
            )?;
            let thread_id = db.last_insert_rowid() as u32;
            // Record who reviewed the change now, so the Dossier names the reviewer even before
            // the reply is parsed.
            db.execute(
                "INSERT INTO blind_reviews (thread_id, review_thread_id, provider, scope)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    request.thread_id,
                    thread_id,
                    request.provider,
                    request.scope
                ],
            )?;
            thread_id
        };

        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let thread_summary = self.get_thread_by_id(&db, thread_id)?;
        drop(db);
        self.board.publish(thread_id);

        Ok((thread_summary, prompt))
    }

    /// Starts a Blind review: creates the Thread with a detached worktree at the reviewed state,
    /// and sends the review prompt.
    pub fn start_blind_review(&self, request: BlindReviewRequest) -> Result<ThreadSummary> {
        let (thread, prompt) = self.create_blind_review_thread(request)?;
        self.send_prompt(thread.id, &prompt)?;
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        self.get_thread_by_id(&db, thread.id)
    }

    /// Parses and records the findings of every finished Blind review of `thread_id` (or of the
    /// review Thread itself), then lists them. Parsing happens once per review and keeps every
    /// reply, including one that cannot be parsed, as plain text.
    pub fn list_blind_review_findings(&self, thread_id: u32) -> Result<Vec<BlindReviewFinding>> {
        self.record_blind_review_findings(thread_id)?;
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT f.id, r.review_thread_id, r.provider, f.path, f.side, f.line, f.code, f.body,
                    f.anchored, f.decision
             FROM blind_review_findings f JOIN blind_reviews r ON r.id = f.review_id
             WHERE r.thread_id = ?1 OR r.review_thread_id = ?1
             ORDER BY r.id, f.id",
        )?;
        let findings = stmt
            .query_map([thread_id], |r| {
                let side: Option<String> = r.get(4)?;
                Ok(BlindReviewFinding {
                    id: r.get(0)?,
                    review_thread_id: r.get(1)?,
                    provider: r.get(2)?,
                    path: r.get(3)?,
                    side: side.map(|s| CommentSide::parse(&s)),
                    line: r.get(5)?,
                    code: r.get(6)?,
                    body: r.get(7)?,
                    plain: r.get::<_, i64>(8)? == 0,
                    decision: FindingDecision::parse(&r.get::<_, String>(9)?),
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(findings)
    }

    /// Keeps one finding. An anchored finding becomes a draft Line comment on the reviewed Thread,
    /// using the same send flow as every other draft; a plain-text finding stays visible but has
    /// no line to attach to. Keeping twice returns the same draft.
    pub fn keep_blind_review_finding(&self, id: u32) -> Result<Option<LineComment>> {
        let (reviewed, scope, provider, path, side, line, code, body, anchored) = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.query_row(
                "SELECT r.thread_id, r.scope, r.provider, f.path, f.side, f.line, f.code, f.body,
                        f.anchored
                 FROM blind_review_findings f JOIN blind_reviews r ON r.id = f.review_id
                 WHERE f.id = ?1",
                [id],
                |r| {
                    let scope: String = r.get(1)?;
                    let side: Option<String> = r.get(4)?;
                    Ok((
                        r.get::<_, Option<u32>>(0)?,
                        CommentScope::parse(&scope),
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        side.map(|s| CommentSide::parse(&s)),
                        r.get::<_, Option<u32>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                        r.get::<_, i64>(8)? != 0,
                    ))
                },
            )?
        };
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            db.execute(
                "UPDATE blind_review_findings SET decision = 'kept' WHERE id = ?1",
                [id],
            )?;
        }
        let (Some(thread_id), true, Some(path), Some(side), Some(line)) =
            (reviewed, anchored, path, side, line)
        else {
            return Ok(None);
        };
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let existing = db.query_row(
                "SELECT id, scope, path, side, line, code, body, provider FROM line_comments
                 WHERE finding_id = ?1",
                [id],
                |r| {
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
                        provider: r.get(7)?,
                    })
                },
            );
            if let Ok(comment) = existing {
                return Ok(Some(comment));
            }
            db.execute(
                "INSERT INTO line_comments
                 (thread_id, scope, path, side, line, code, body, provider, finding_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    thread_id,
                    scope.as_str(),
                    path,
                    side.as_str(),
                    line,
                    code,
                    body,
                    provider,
                    id
                ],
            )?;
            let comment_id = db.last_insert_rowid() as u32;
            Ok(Some(LineComment {
                id: comment_id,
                thread_id,
                scope,
                path,
                side,
                line,
                code,
                body,
                outdated: false,
                provider: Some(provider),
            }))
        }
    }

    /// Dismisses one finding: it never reaches the Thread, and a draft it already made is removed.
    pub fn dismiss_blind_review_finding(&self, id: u32) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "UPDATE blind_review_findings SET decision = 'dismissed' WHERE id = ?1",
            [id],
        )?;
        db.execute("DELETE FROM line_comments WHERE finding_id = ?1", [id])?;
        Ok(())
    }

    fn record_blind_review_findings(&self, thread_id: u32) -> Result<()> {
        let reviews: Vec<(u32, u32, String)> = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let mut stmt = db.prepare(
                "SELECT r.id, r.review_thread_id, r.scope FROM blind_reviews r
                 WHERE r.thread_id = ?1 OR r.review_thread_id = ?1 ORDER BY r.id",
            )?;
            stmt.query_map([thread_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<std::result::Result<_, _>>()?
        };
        for (review_id, review_thread_id, _scope) in reviews {
            let recorded: u32 = {
                let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
                db.query_row(
                    "SELECT COUNT(*) FROM blind_review_findings WHERE review_id = ?1",
                    [review_id],
                    |r| r.get(0),
                )?
            };
            if recorded > 0 {
                continue;
            }
            let snapshot = self.storage.get_snapshot(review_thread_id, u32::MAX)?;
            if snapshot.thread.status == ThreadStatus::Working {
                continue;
            }
            let Some(prompt) = snapshot.turns.first().map(|t| t.prompt.clone()) else {
                continue;
            };
            let Some(closing) = snapshot
                .turns
                .iter()
                .rev()
                .find_map(|turn| turn.final_agent_message())
            else {
                continue;
            };
            let diff_text = prompt_diff(&prompt).unwrap_or("");
            let findings = parse_findings(&closing.content, diff_text);
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let tx = crate::db::write_transaction(&db)?;
            // Two readers may have reached this point together; only one writes the findings.
            let recorded: u32 = tx.query_row(
                "SELECT COUNT(*) FROM blind_review_findings WHERE review_id = ?1",
                [review_id],
                |r| r.get(0),
            )?;
            if recorded == 0 {
                for finding in findings {
                    tx.execute(
                        "INSERT INTO blind_review_findings
                         (review_id, path, side, line, code, body, anchored)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        rusqlite::params![
                            review_id,
                            finding.path,
                            finding.side.map(CommentSide::as_str),
                            finding.line,
                            finding.code,
                            finding.body,
                            finding.anchored as i64,
                        ],
                    )?;
                }
            }
            tx.commit()?;
        }
        Ok(())
    }

    /// Who reviewed this change and how many findings stayed, for the Dossier.
    pub(crate) fn blind_review_summaries(&self, thread_id: u32) -> Result<Vec<BlindReviewSummary>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT r.review_thread_id, r.provider,
                    (SELECT COUNT(*) FROM blind_review_findings f WHERE f.review_id = r.id),
                    (SELECT COUNT(*) FROM blind_review_findings f
                     WHERE f.review_id = r.id AND f.decision = 'kept')
             FROM blind_reviews r WHERE r.thread_id = ?1 ORDER BY r.id",
        )?;
        let summaries = stmt
            .query_map([thread_id], |r| {
                Ok(BlindReviewSummary {
                    review_thread_id: r.get(0)?,
                    provider: r.get(1)?,
                    findings: r.get(2)?,
                    kept: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(summaries)
    }
}

struct ParsedFinding {
    path: Option<String>,
    side: Option<CommentSide>,
    line: Option<u32>,
    code: String,
    body: String,
    anchored: bool,
}

/// The reviewed Diff embedded in the Blind review prompt.
fn prompt_diff(prompt: &str) -> Option<&str> {
    let rest = prompt.split_once("<diff>\n")?.1;
    let end = rest.find("\n</diff>")?;
    Some(&rest[..end])
}

/// Every line of the reviewed Diff, by path, side and line number.
fn diff_anchors(diff_text: &str) -> std::collections::HashMap<(String, CommentSide, u32), String> {
    let mut anchors = std::collections::HashMap::new();
    for file in git_diff::parse_patch(diff_text) {
        for hunk in &file.hunks {
            let Some((mut old, mut new)) = hunk_starts(&hunk.header) else {
                continue;
            };
            for line in &hunk.lines {
                match line.kind {
                    DiffKind::Context => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::New, new),
                            line.text.clone(),
                        );
                        anchors.insert(
                            (file.path.clone(), CommentSide::Old, old),
                            line.text.clone(),
                        );
                        old += 1;
                        new += 1;
                    }
                    DiffKind::Added => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::New, new),
                            line.text.clone(),
                        );
                        new += 1;
                    }
                    DiffKind::Removed => {
                        anchors.insert(
                            (file.path.clone(), CommentSide::Old, old),
                            line.text.clone(),
                        );
                        old += 1;
                    }
                }
            }
        }
    }
    anchors
}

/// The first line number of each side from `@@ -old +new @@`.
fn hunk_starts(header: &str) -> Option<(u32, u32)> {
    let inner = header.strip_prefix("@@ ")?.split(" @@").next()?;
    let mut parts = inner.split(' ');
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;
    Some((
        old.split(',').next()?.parse().ok()?,
        new.split(',').next()?.parse().ok()?,
    ))
}

fn anchor(
    anchors: &std::collections::HashMap<(String, CommentSide, u32), String>,
    path: &str,
    line: u32,
) -> Option<(String, CommentSide, u32, String)> {
    let mut variants = vec![path.to_string()];
    if let Some(rest) = path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
        variants.push(rest.to_string());
    }
    for candidate in variants {
        for side in [CommentSide::New, CommentSide::Old] {
            if let Some(code) = anchors.get(&(candidate.clone(), side, line)) {
                return Some((candidate, side, line, code.clone()));
            }
        }
    }
    None
}

/// Findings from the closing message, validated against the reviewed Diff. A reply that cannot
/// be parsed, or a finding that cannot be anchored, comes back as plain text.
fn parse_findings(message: &str, diff_text: &str) -> Vec<ParsedFinding> {
    let anchors = diff_anchors(diff_text);
    let Some(values) = extract_json(message) else {
        return vec![ParsedFinding {
            path: None,
            side: None,
            line: None,
            code: String::new(),
            body: message.trim().to_string(),
            anchored: false,
        }];
    };
    let mut findings = Vec::new();
    for value in values {
        let path = value.get("path").and_then(|v| v.as_str());
        let line = value.get("line").and_then(|v| v.as_u64()).map(|n| n as u32);
        let body = value
            .get("body")
            .and_then(|v| v.as_str())
            .or_else(|| value.as_str())
            .map(str::to_string);
        if let (Some(path), Some(line), Some(body)) = (path, line, body.clone()) {
            if let Some((path, side, line, code)) = anchor(&anchors, path, line) {
                findings.push(ParsedFinding {
                    path: Some(path),
                    side: Some(side),
                    line: Some(line),
                    code,
                    body,
                    anchored: true,
                });
                continue;
            }
            findings.push(ParsedFinding {
                path: Some(path.to_string()),
                side: None,
                line: Some(line),
                code: String::new(),
                body,
                anchored: false,
            });
            continue;
        }
        findings.push(ParsedFinding {
            path: path.map(str::to_string),
            side: None,
            line,
            code: String::new(),
            body: body.unwrap_or_else(|| value.to_string()),
            anchored: false,
        });
    }
    findings
}

/// The JSON array in a closing message, whether bare or inside a code fence or prose.
fn extract_json(message: &str) -> Option<Vec<serde_json::Value>> {
    for candidate in json_candidates(message) {
        if let Ok(serde_json::Value::Array(values)) =
            serde_json::from_str::<serde_json::Value>(candidate)
        {
            return Some(values);
        }
    }
    None
}

fn json_candidates(message: &str) -> Vec<&str> {
    let message = message.trim();
    let mut candidates = vec![message];
    let mut rest = message;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let Some(end) = after.find("```") else {
            break;
        };
        candidates.push(after[..end].trim());
        rest = &after[end + 3..];
    }
    if let (Some(start), Some(end)) = (message.find('['), message.rfind(']'))
        && start < end
    {
        candidates.push(&message[start..=end]);
    }
    candidates
}
