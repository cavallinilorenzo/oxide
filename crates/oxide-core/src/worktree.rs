//! Dispatching a task from the Thread Board: a Thread of its own in a git worktree on an
//! `oxide/` branch, prepared by the Project's Setup command before its first Turn.

use crate::{Core, Error, PermissionMode, Result, ThreadStatus, ThreadSummary, git};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Setup output kept in the Thread: the tail of what the command printed.
const MAX_SETUP_OUTPUT: usize = 64 * 1024;

/// A Board Thread handed off from the Thread Board. Unset Model, Effort and Permission mode fall back to the
/// Provider's defaults from Settings, an unset base branch to the main checkout's current branch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub project_id: u32,
    pub prompt: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub base_branch: Option<String>,
    /// The GitHub issue the task comes from: the Thread remembers it and its branch is
    /// `oxide/<issue-n>-<slug of the issue title>`.
    pub issue_number: Option<u32>,
    pub issue_title: Option<String>,
}

/// `body` closing issue `n` when merged: unchanged if it already has a `Closes #n`.
pub(crate) fn closing_issue(body: &str, n: u32) -> String {
    let line = format!("Closes #{n}");
    if body.to_lowercase().contains(&line.to_lowercase()) {
        body.to_string()
    } else if body.trim().is_empty() {
        line
    } else {
        format!("{}\n\n{line}", body.trim_end())
    }
}

/// `Fix the login bug!` →`fix-the-login-bug`; never empty.
fn slugify(text: &str, fallback: &str) -> String {
    let mut slug = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        fallback.to_string()
    } else {
        slug.to_string()
    }
}

/// The first `slug`, `slug-2`, `slug-3`… that is neither a branch `oxide/<name>` nor a folder in
/// `parent`.
fn free_name(checkout: &Path, parent: &Path, slug: &str) -> String {
    (1..)
        .map(|n| {
            if n == 1 {
                slug.to_string()
            } else {
                format!("{slug}-{n}")
            }
        })
        .find(|name| {
            !parent.join(name).exists()
                && !git::ref_exists(checkout, &format!("refs/heads/oxide/{name}"))
        })
        .expect("an unbounded range has a free name")
}

/// What archiving a Thread did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveOutcome {
    Archived,
    /// The Board Thread's worktree has uncommitted changes; nothing was changed.
    NeedsConfirmation,
}

struct SetupRun {
    success: bool,
    output: String,
}

/// Runs `command` through the shell in `worktree`, stdout and stderr interleaved.
fn run_setup(command: &str, worktree: &Path, project_root: &Path) -> SetupRun {
    #[cfg(unix)]
    let mut cmd = {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(format!("exec 2>&1\n{command}"));
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(format!("{command} 2>&1"));
        cmd
    };
    let result = cmd
        .current_dir(worktree)
        .env("OXIDE_PROJECT_ROOT", project_root)
        .stdin(Stdio::null())
        .output();
    let (success, mut output) = match result {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            if !out.status.success() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&format!("Setup command failed ({}).\n", out.status));
            }
            (out.status.success(), text)
        }
        Err(e) => (false, format!("Could not run the Setup command: {e}\n")),
    };
    if output.len() > MAX_SETUP_OUTPUT {
        let mut start = output.len() - MAX_SETUP_OUTPUT;
        while !output.is_char_boundary(start) {
            start += 1;
        }
        output = format!("…{}", &output[start..]);
    }
    SetupRun { success, output }
}

impl Core {
    /// The Project's Setup command, kept by Oxide and never written into its repository.
    pub fn project_setup_command(&self, project_id: u32) -> Result<Option<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db.query_row(
            "SELECT setup_command FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )?)
    }

    /// Sets the Project's Setup command; blank clears it.
    pub fn set_project_setup_command(&self, project_id: u32, command: Option<&str>) -> Result<()> {
        let command = command.map(str::trim).filter(|c| !c.is_empty());
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let changed = db.execute(
            "UPDATE projects SET setup_command = ?1 WHERE id = ?2",
            rusqlite::params![command, project_id],
        )?;
        if changed == 0 {
            return Err(Error::Db(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Hands a task off to a new background Thread: a worktree on a fresh `oxide/` branch cut from
    /// the base branch's local commits, the Setup command run in it, then the first Turn. A
    /// failing Setup command leaves the Thread in needs input with no Turn started.
    pub fn dispatch_thread(&self, request: DispatchRequest) -> Result<ThreadSummary> {
        let prompt = request.prompt.trim();
        if prompt.is_empty() {
            return Err(Error::Git("Enter a prompt to dispatch.".into()));
        }
        let project = self.project(request.project_id)?;
        let root = PathBuf::from(&project.path);
        let base = match request.base_branch.as_deref().map(str::trim) {
            Some(base) if !base.is_empty() => base.to_string(),
            _ => git::run(&root, &["rev-parse", "--abbrev-ref", "HEAD"])?
                .trim()
                .to_string(),
        };
        if base.starts_with('-') {
            return Err(Error::Git(format!("`{base}` is not a valid branch.")));
        }
        // A local branch wins over a tag or remote ref of the same name.
        let local = format!("refs/heads/{base}");
        let base = if git::ref_exists(&root, &local) {
            local
        } else {
            base
        };

        let parent = self
            .home
            .join("worktrees")
            .join(slugify(&project.name, "project"));
        let slug = match request.issue_number {
            Some(n) => {
                let title = request.issue_title.as_deref().unwrap_or(prompt);
                format!(
                    "{n}-{}",
                    slugify(&crate::thread::truncate_title(title), "thread")
                )
            }
            None => slugify(&crate::thread::truncate_title(prompt), "thread"),
        };
        let (branch, worktree) = self.git.mutate(&root, || {
            std::fs::create_dir_all(&parent).map_err(|source| Error::Io {
                path: parent.clone(),
                source,
            })?;
            let name = free_name(&root, &parent, &slug);
            let branch = format!("oxide/{name}");
            let worktree = parent.join(&name);
            git::run(
                &root,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    &branch,
                    &worktree.to_string_lossy(),
                    &base,
                ],
            )?;
            Ok((branch, worktree))
        })?;

        let (def_model, def_effort, def_perm) =
            self.default_settings_for_provider(&request.provider);
        let thread = self.insert_thread(
            project.id,
            &request.provider,
            request.model.or(def_model),
            request.effort.or(def_effort),
            request.permission_mode.unwrap_or(def_perm),
            None,
        )?;
        self.db.lock().unwrap_or_else(|e| e.into_inner()).execute(
            "UPDATE threads SET branch = ?1, worktree_path = ?2, issue_number = ?3 WHERE id = ?4",
            rusqlite::params![
                branch,
                worktree.to_string_lossy(),
                request.issue_number,
                thread.id
            ],
        )?;

        if let Some(command) = self.project_setup_command(project.id)? {
            let run = run_setup(&command, &worktree, &root);
            let status = if run.success {
                None
            } else {
                Some(ThreadStatus::NeedsInput)
            };
            {
                let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
                db.execute(
                    "UPDATE threads SET setup_output = ?1, status = COALESCE(?2, status) WHERE id = ?3",
                    rusqlite::params![run.output, status.map(|s| s.to_string()), thread.id],
                )?;
            }
            if !run.success {
                self.board.publish(thread.id);
                return self.thread_summary(thread.id);
            }
        }
        self.board.publish(thread.id);

        self.send_prompt(thread.id, prompt)?;
        self.thread_summary(thread.id)
    }

    /// The issue a Board Thread of the Project was started from on `branch`, if any.
    pub(crate) fn issue_of_branch(&self, project_id: u32, branch: &str) -> Result<Option<u32>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let found: Option<Option<u32>> = db
            .query_row(
                "SELECT issue_number FROM threads WHERE project_id = ?1 AND branch = ?2 AND issue_number IS NOT NULL ORDER BY id DESC LIMIT 1",
                rusqlite::params![project_id, branch],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        Ok(found.flatten())
    }

    /// The Project's root and, for a Board Thread, its branch and worktree.
    fn thread_checkouts(&self, thread_id: u32) -> Result<(PathBuf, Option<(String, PathBuf)>)> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db.query_row(
            "SELECT p.path, t.branch, t.worktree_path FROM threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?1",
            [thread_id],
            |r| {
                let root = PathBuf::from(r.get::<_, String>(0)?);
                let branch: Option<String> = r.get(1)?;
                let worktree: Option<String> = r.get(2)?;
                Ok((root, branch.zip(worktree.map(PathBuf::from))))
            },
        )?)
    }

    /// Archives a Thread. A Board Thread's worktree is removed with it and its branch kept, unless
    /// the worktree has uncommitted changes: then nothing happens until the caller confirms with
    /// `discard_changes`.
    pub fn archive_thread(&self, thread_id: u32, discard_changes: bool) -> Result<ArchiveOutcome> {
        let (root, board) = self.thread_checkouts(thread_id)?;
        if let Some((_, worktree)) = board.filter(|(_, w)| w.exists()) {
            let removed = self.git.mutate(&root, || {
                let dirty = !git::run(&worktree, &["status", "--porcelain"])?
                    .trim()
                    .is_empty();
                if dirty && !discard_changes {
                    return Ok(false);
                }
                git::run(
                    &root,
                    &["worktree", "remove", "--force", &worktree.to_string_lossy()],
                )?;
                Ok(true)
            })?;
            if !removed {
                return Ok(ArchiveOutcome::NeedsConfirmation);
            }
        }
        self.set_thread_archived(thread_id, true)?;
        Ok(ArchiveOutcome::Archived)
    }

    /// Recreates a Board Thread's worktree from its branch when it is gone (archived, or deleted
    /// by hand). A chat Thread, or a worktree still there, is left alone.
    pub(crate) fn ensure_worktree(&self, thread_id: u32) -> Result<()> {
        let (root, board) = self.thread_checkouts(thread_id)?;
        let Some((branch, worktree)) = board.filter(|(_, w)| !w.exists()) else {
            return Ok(());
        };
        self.git.mutate(&root, || {
            // Drop the stale registration, or `add` refuses the branch as checked out elsewhere.
            git::run(&root, &["worktree", "prune"])?;
            if let Some(parent) = worktree.parent() {
                std::fs::create_dir_all(parent).map_err(|source| Error::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            }
            git::run(
                &root,
                &[
                    "worktree",
                    "add",
                    "-q",
                    &worktree.to_string_lossy(),
                    &branch,
                ],
            )?;
            Ok(())
        })
    }

    /// Housekeeping when a Project opens: forgets worktrees whose folder was deleted by hand.
    pub fn open_project(&self, project_id: u32) -> Result<()> {
        let root = PathBuf::from(self.project(project_id)?.path);
        self.git
            .mutate(&root, || git::run(&root, &["worktree", "prune"]).map(drop))
    }

    fn thread_summary(&self, thread_id: u32) -> Result<ThreadSummary> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        self.get_thread_by_id(&db, thread_id)
    }
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugs_are_lowercase_dashed_and_never_empty() {
        assert_eq!(slugify("Fix the login bug!", "thread"), "fix-the-login-bug");
        assert_eq!(slugify("  --Ünï/cødé--  ", "thread"), "n-c-d");
        assert_eq!(slugify("!!!", "thread"), "thread");
        assert_eq!(slugify(&"a".repeat(100), "thread").len(), 40);
    }
}
