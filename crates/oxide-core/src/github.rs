//! GitHub through the `gh` CLI. The token never leaves `gh`, and the repository
//! is whatever `gh` resolves from the checkout. Nothing here runs unless the
//! user asked: there is no polling.

use crate::git;
use crate::git_diff::{Diff, parse_patch};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

const INSTALL_GUIDANCE: &str =
    "Install the GitHub CLI (https://cli.github.com), then run `gh auth login`.";
const LOGIN_GUIDANCE: &str = "The GitHub CLI is not logged in. Run `gh auth login` in a terminal.";

/// Where a GUI app, which inherits a minimal PATH, may find a Homebrew `gh`.
const FALLBACK_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// Commits listed when prefilling a pull request.
const MAX_PREFILL_COMMITS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GithubAvailability {
    Ready,
    Missing,
    LoggedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub draft: bool,
    pub base: String,
    pub head: String,
    pub author: String,
}

/// How `gh pr merge` combines the commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    fn flag(self) -> &'static str {
        match self {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        }
    }

    fn name(self) -> &'static str {
        match self {
            MergeMethod::Merge => "merge",
            MergeMethod::Squash => "squash",
            MergeMethod::Rebase => "rebase",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
}

impl CheckState {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckState::Success => "success",
            CheckState::Failure => "failure",
            CheckState::Pending => "pending",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    pub name: String,
    pub state: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

/// Everything the Pull request Surface shows for one pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub pull_request: PullRequest,
    pub body: String,
    pub checks: Vec<PullRequestCheck>,
    pub comments: Vec<PullRequestComment>,
    /// The merge methods the repository allows.
    pub merge_methods: Vec<MergeMethod>,
    /// Whether the repository deletes merged branches on its own.
    pub delete_branch_on_merge: bool,
    /// The changed files, for the Diff Surface.
    pub diff: Diff,
}

/// What the Pull request Surface shows for the current branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestState {
    pub availability: GithubAvailability,
    /// How to get `gh` working, when it is not.
    pub guidance: Option<String>,
    /// `None` while HEAD is detached.
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    /// The branch's open pull request, if it has one.
    pub pull_request: Option<PullRequest>,
}

/// The form a new pull request starts from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDraft {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestInput {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
}

enum GhError {
    Missing,
    Failed(String),
}

/// How `gh` is found: the process PATH plus Homebrew's, unless a search path
/// replaces it (tests put a fake `gh` alone on it).
#[derive(Default)]
pub struct Gh {
    search_path: Mutex<Option<Vec<PathBuf>>>,
}

impl Gh {
    pub fn set_search_path(&self, dirs: Option<Vec<PathBuf>>) {
        *self.search_path.lock().unwrap_or_else(|e| e.into_inner()) = dirs;
    }

    fn path_var(&self) -> OsString {
        let dirs = match self
            .search_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            Some(dirs) => dirs,
            None => {
                let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
                    .map(|p| std::env::split_paths(&p).collect())
                    .unwrap_or_default();
                dirs.extend(FALLBACK_DIRS.iter().map(PathBuf::from));
                dirs
            }
        };
        std::env::join_paths(dirs).unwrap_or_default()
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> std::result::Result<String, GhError> {
        let path = self.path_var();
        let output = Command::new(find_in(&path, "gh").ok_or(GhError::Missing)?)
            .args(args)
            .current_dir(cwd)
            .env("PATH", &path)
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => GhError::Missing,
                _ => GhError::Failed(format!("could not run gh: {e}")),
            })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&output.stdout)
        } else {
            stderr
        };
        Err(GhError::Failed(message.trim().to_string()))
    }

    /// Whether `gh` can be used, and if not, what to tell the user.
    fn availability(&self, cwd: &Path) -> (GithubAvailability, Option<String>) {
        match self.run(cwd, &["auth", "status"]) {
            Ok(_) => (GithubAvailability::Ready, None),
            Err(GhError::Missing) => (GithubAvailability::Missing, Some(INSTALL_GUIDANCE.into())),
            Err(GhError::Failed(_)) => (GithubAvailability::LoggedOut, Some(LOGIN_GUIDANCE.into())),
        }
    }

    fn require_ready(&self, cwd: &Path) -> Result<()> {
        match self.availability(cwd) {
            (GithubAvailability::Ready, _) => Ok(()),
            (_, guidance) => Err(Error::Github(guidance.unwrap_or_default())),
        }
    }

    fn default_branch(&self, cwd: &Path) -> Result<String> {
        let json = self.run(cwd, &["repo", "view", "--json", "defaultBranchRef"])?;
        let value: serde_json::Value = parse(&json)?;
        value["defaultBranchRef"]["name"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Github("GitHub did not report a default branch.".into()))
    }

    /// The open pull request of the checked-out branch.
    fn current_pull_request(&self, cwd: &Path) -> Result<Option<PullRequest>> {
        let json = match self.run(cwd, &["pr", "view", "--json", PR_FIELDS]) {
            Ok(json) => json,
            Err(GhError::Failed(m)) if m.contains("no pull requests found") => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let v: serde_json::Value = parse(&json)?;
        if v["state"].as_str() != Some("OPEN") {
            return Ok(None);
        }
        Ok(Some(pull_request_from(&v)))
    }
}

const PR_FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,author";

/// Most pull requests the list shows.
const MAX_LISTED: &str = "100";

fn text(value: &serde_json::Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn pull_request_from(v: &serde_json::Value) -> PullRequest {
    PullRequest {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: text(&v["title"]),
        url: text(&v["url"]),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        base: text(&v["baseRefName"]),
        head: text(&v["headRefName"]),
        author: text(&v["author"]["login"]),
    }
}

/// A check run or a commit status, as `statusCheckRollup` lists them.
fn check_from(v: &serde_json::Value) -> PullRequestCheck {
    let state = if v["__typename"].as_str() == Some("StatusContext") {
        match v["state"].as_str() {
            Some("SUCCESS") => CheckState::Success,
            Some("PENDING" | "EXPECTED") => CheckState::Pending,
            _ => CheckState::Failure,
        }
    } else if v["status"].as_str() != Some("COMPLETED") {
        CheckState::Pending
    } else {
        match v["conclusion"].as_str() {
            Some("SUCCESS" | "NEUTRAL" | "SKIPPED") => CheckState::Success,
            _ => CheckState::Failure,
        }
    };
    PullRequestCheck {
        // Check runs have a `name`, commit statuses a `context`.
        name: v["name"]
            .as_str()
            .or_else(|| v["context"].as_str())
            .unwrap_or_default()
            .to_string(),
        state,
    }
}

impl From<GhError> for Error {
    fn from(e: GhError) -> Self {
        match e {
            GhError::Missing => Error::Github(INSTALL_GUIDANCE.into()),
            GhError::Failed(message) => Error::Github(message),
        }
    }
}

fn parse(json: &str) -> Result<serde_json::Value> {
    serde_json::from_str(json).map_err(|e| Error::Github(format!("unexpected gh output: {e}")))
}

fn find_in(path: &OsString, program: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

pub fn pull_request_state(gh: &Gh, cwd: &Path) -> Result<PullRequestState> {
    let branch = git::status(cwd)?.branch;
    let (availability, guidance) = gh.availability(cwd);
    let mut state = PullRequestState {
        availability,
        guidance,
        branch,
        default_branch: None,
        pull_request: None,
    };
    if availability == GithubAvailability::Ready {
        state.default_branch = Some(gh.default_branch(cwd)?);
        if state.branch.is_some() {
            state.pull_request = gh.current_pull_request(cwd)?;
        }
    }
    Ok(state)
}

/// Title and body from the commits the branch adds to the default branch: a
/// lone commit's own message, or the branch's name over a list of subjects.
pub fn pull_request_draft(gh: &Gh, cwd: &Path) -> Result<PullRequestDraft> {
    gh.require_ready(cwd)?;
    let head = current_branch(cwd)?;
    let base = gh.default_branch(cwd)?;
    let remote_base = format!("origin/{base}");
    let range = if git::ref_exists(cwd, &remote_base) {
        format!("{remote_base}..HEAD")
    } else if git::ref_exists(cwd, &base) {
        format!("{base}..HEAD")
    } else {
        "HEAD".to_string()
    };
    let max = format!("--max-count={MAX_PREFILL_COMMITS}");
    let log = git::run(
        cwd,
        &["log", "--reverse", &max, "--format=%s%x1f%b%x1e", &range],
    )?;
    let commits: Vec<(&str, &str)> = log
        .split('\x1e')
        .filter(|record| !record.trim().is_empty())
        .map(|record| {
            let (subject, body) = record.split_once('\x1f').unwrap_or((record, ""));
            (subject.trim(), body.trim())
        })
        .collect();
    let (title, body) = match commits.as_slice() {
        [] => (humanize(&head), String::new()),
        [(subject, body)] => (subject.to_string(), body.to_string()),
        many => (
            humanize(&head),
            many.iter()
                .map(|(subject, _)| format!("- {subject}"))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
    };
    Ok(PullRequestDraft {
        title,
        body,
        base,
        head,
    })
}

/// `add-pr-surface` → `Add pr surface`.
fn humanize(branch: &str) -> String {
    let words = branch
        .rsplit('/')
        .next()
        .unwrap_or(branch)
        .replace(['-', '_'], " ");
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn current_branch(cwd: &Path) -> Result<String> {
    git::status(cwd)?
        .branch
        .ok_or_else(|| Error::Github("HEAD is detached; switch to a branch first.".into()))
}

/// Pushes the branch if GitHub has not seen all of it, then opens the pull
/// request. The caller holds the checkout's Git lock.
pub fn create_pull_request(gh: &Gh, cwd: &Path, input: &PullRequestInput) -> Result<PullRequest> {
    gh.require_ready(cwd)?;
    let status = git::status(cwd)?;
    let branch = current_branch(cwd)?;
    if status.protected {
        return Err(Error::Github(format!(
            "`{branch}` is a main branch; create a branch to open a pull request from."
        )));
    }
    let title = input.title.trim();
    if title.is_empty() {
        return Err(Error::Github("Write a pull request title.".into()));
    }
    let base = input.base.trim();
    if base.is_empty() || base == branch {
        return Err(Error::Github(
            "Choose a base branch other than the current one.".into(),
        ));
    }
    if status.ahead > 0 || status.unpublished {
        git::push(cwd, false)?;
    }
    let mut args = vec![
        "pr",
        "create",
        "--title",
        title,
        "--body",
        &input.body,
        "--base",
        base,
        "--head",
        &branch,
    ];
    if input.draft {
        args.push("--draft");
    }
    gh.run(cwd, &args)?;
    gh.current_pull_request(cwd)?
        .ok_or_else(|| Error::Github("The pull request was created but could not be read.".into()))
}

/// The URL of the branch's open pull request.
pub fn pull_request_url(gh: &Gh, cwd: &Path) -> Result<String> {
    gh.require_ready(cwd)?;
    let pr = gh
        .current_pull_request(cwd)?
        .ok_or_else(|| Error::Github("This branch has no open pull request.".into()))?;
    if !pr.url.starts_with("https://") {
        return Err(Error::Github(format!(
            "Unexpected pull request URL: {}",
            pr.url
        )));
    }
    Ok(pr.url)
}

/// Open pull requests of the repository, optionally only the user's own and
/// narrowed by a GitHub search query.
pub fn list_pull_requests(
    gh: &Gh,
    cwd: &Path,
    mine: bool,
    search: &str,
) -> Result<Vec<PullRequest>> {
    gh.require_ready(cwd)?;
    let mut args = vec![
        "pr", "list", "--state", "open", "--limit", MAX_LISTED, "--json", PR_FIELDS,
    ];
    if mine {
        args.extend(["--author", "@me"]);
    }
    let search = search.trim();
    if !search.is_empty() {
        args.extend(["--search", search]);
    }
    let list = parse(&gh.run(cwd, &args)?)?;
    Ok(list
        .as_array()
        .map(|prs| prs.iter().map(pull_request_from).collect())
        .unwrap_or_default())
}

/// One pull request with its description, checks, conversation, the merge
/// methods the repository allows and its changed files.
pub fn pull_request_detail(gh: &Gh, cwd: &Path, number: u32) -> Result<PullRequestDetail> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let fields = format!("{PR_FIELDS},body,comments,statusCheckRollup");
    let v = parse(&gh.run(cwd, &["pr", "view", &n, "--json", &fields])?)?;
    let (merge_methods, delete_branch_on_merge) = merge_settings(gh, cwd)?;
    let patch = gh.run(cwd, &["pr", "diff", &n, "--color=never"])?;

    let pull_request = pull_request_from(&v);
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    Ok(PullRequestDetail {
        body: text(&v["body"]),
        checks: list("statusCheckRollup").iter().map(check_from).collect(),
        comments: list("comments")
            .iter()
            .map(|c| PullRequestComment {
                author: text(&c["author"]["login"]),
                body: text(&c["body"]),
                created_at: text(&c["createdAt"]),
            })
            .collect(),
        merge_methods,
        delete_branch_on_merge,
        diff: Diff {
            base: Some(pull_request.base.clone()),
            files: parse_patch(&patch),
        },
        pull_request,
    })
}

/// Adds a conversation comment.
pub fn comment_pull_request(gh: &Gh, cwd: &Path, number: u32, body: &str) -> Result<()> {
    let body = body.trim();
    if body.is_empty() {
        return Err(Error::Github("Write a comment first.".into()));
    }
    gh.require_ready(cwd)?;
    gh.run(cwd, &["pr", "comment", &number.to_string(), "--body", body])?;
    Ok(())
}

/// The merge methods the repository allows, and whether it deletes merged
/// branches on its own.
fn merge_settings(gh: &Gh, cwd: &Path) -> Result<(Vec<MergeMethod>, bool)> {
    let repo = parse(&gh.run(
        cwd,
        &[
            "repo",
            "view",
            "--json",
            "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge",
        ],
    )?)?;
    let allowed = |key: &str| repo[key].as_bool().unwrap_or(false);
    let methods = [
        ("mergeCommitAllowed", MergeMethod::Merge),
        ("squashMergeAllowed", MergeMethod::Squash),
        ("rebaseMergeAllowed", MergeMethod::Rebase),
    ]
    .into_iter()
    .filter(|(key, _)| allowed(key))
    .map(|(_, method)| method)
    .collect();
    Ok((methods, allowed("deleteBranchOnMerge")))
}

/// Merges with a method the repository allows. The caller holds the
/// checkout's Git lock: deleting the branch may move the checkout off it.
pub fn merge_pull_request(
    gh: &Gh,
    cwd: &Path,
    number: u32,
    method: MergeMethod,
    delete_branch: bool,
) -> Result<()> {
    gh.require_ready(cwd)?;
    if !merge_settings(gh, cwd)?.0.contains(&method) {
        return Err(Error::Github(format!(
            "The repository does not allow {} merges.",
            method.name()
        )));
    }
    let n = number.to_string();
    let mut args = vec!["pr", "merge", &n, method.flag()];
    if delete_branch {
        args.push("--delete-branch");
    }
    gh.run(cwd, &args)?;
    Ok(())
}

/// Checks the pull request's branch out in `cwd`. Git's refusal is the error.
pub fn checkout_pull_request(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["pr", "checkout", &number.to_string()])?;
    Ok(())
}
