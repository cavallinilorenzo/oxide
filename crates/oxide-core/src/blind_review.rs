//! Blind review: a review of a change by another installed Provider that receives only the
//! diff and the issue, with no Transcript content, in a detached worktree at the reviewed state
//! where it cannot touch the user's checkout.

use crate::checkpoint;
use crate::git;
use crate::git_diff;
use crate::thread::ThreadSummary;
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
                "INSERT INTO threads (project_id, provider, model, effort, permission_mode, status, title, worktree_path, blind_review)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?7, 1)",
                rusqlite::params![
                    request.project_id,
                    request.provider,
                    model,
                    effort,
                    PermissionMode::Ask.as_str(),
                    title,
                    worktree_path.to_string_lossy(),
                ],
            )?;
            db.last_insert_rowid() as u32
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
}
