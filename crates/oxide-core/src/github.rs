//! GitHub through the `gh` CLI. The token never leaves `gh`, and the repository
//! is whatever `gh` resolves from the checkout. Nothing here runs unless the
//! user asked: there is no polling.

use crate::git;
use crate::{Error, Result};
use serde::Serialize;
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

/// One of the user's GitHub repositories, as offered for cloning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub name_with_owner: String,
    pub description: String,
    pub is_private: bool,
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
        let json = match self.run(
            cwd,
            &[
                "pr",
                "view",
                "--json",
                "number,title,url,state,isDraft,baseRefName,headRefName",
            ],
        ) {
            Ok(json) => json,
            Err(GhError::Failed(m)) if m.contains("no pull requests found") => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let v: serde_json::Value = parse(&json)?;
        if v["state"].as_str() != Some("OPEN") {
            return Ok(None);
        }
        let text = |key: &str| v[key].as_str().unwrap_or_default().to_string();
        Ok(Some(PullRequest {
            number: v["number"].as_u64().unwrap_or(0) as u32,
            title: text("title"),
            url: text("url"),
            draft: v["isDraft"].as_bool().unwrap_or(false),
            base: text("baseRefName"),
            head: text("headRefName"),
        }))
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
    #[cfg(windows)]
    let candidates = [
        format!("{program}.cmd"),
        format!("{program}.exe"),
        format!("{program}.bat"),
        program.to_string(),
    ];
    #[cfg(not(windows))]
    let candidates = [program.to_string()];

    std::env::split_paths(path).find_map(|dir| {
        candidates
            .iter()
            .map(|c| dir.join(c))
            .find(|candidate| candidate.is_file())
    })
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

const ISSUE_FIELDS: &str = "number,title,state,author,url,createdAt,comments";
const ISSUE_DETAIL_FIELDS: &str = "number,title,body,state,author,url,createdAt,comments";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u32,
    pub title: String,
    pub state: String,
    pub author: String,
    pub url: String,
    pub comments_count: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub comments: Vec<IssueComment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuesState {
    pub availability: GithubAvailability,
    pub guidance: Option<String>,
}

fn text(v: &serde_json::Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn issue_summary_from(v: &serde_json::Value) -> IssueSummary {
    IssueSummary {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: text(&v["title"]),
        state: text(&v["state"]),
        author: text(&v["author"]["login"]),
        url: text(&v["url"]),
        comments_count: v["comments"].as_array().map(|c| c.len()).unwrap_or(0) as u32,
        created_at: text(&v["createdAt"]),
    }
}

/// The user's repositories whose name or description contains `query`.
pub fn search_repositories(gh: &Gh, cwd: &Path, query: &str) -> Result<Vec<GithubRepository>> {
    gh.require_ready(cwd)?;
    let list = parse(&gh.run(
        cwd,
        &[
            "repo",
            "list",
            "--limit",
            "200",
            "--json",
            "nameWithOwner,description,isPrivate",
        ],
    )?)?;
    let query = query.trim().to_lowercase();
    Ok(list
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|r| GithubRepository {
            name_with_owner: r["nameWithOwner"].as_str().unwrap_or_default().into(),
            description: r["description"].as_str().unwrap_or_default().into(),
            is_private: r["isPrivate"].as_bool().unwrap_or(false),
        })
        .filter(|r| {
            r.name_with_owner.to_lowercase().contains(&query)
                || r.description.to_lowercase().contains(&query)
        })
        .collect())
}

/// Clones `name_with_owner` into `dest`, which does not exist yet.
pub fn clone_repository(gh: &Gh, name_with_owner: &str, dest: &Path) -> Result<()> {
    let parent = dest.parent().unwrap_or(dest);
    gh.require_ready(parent)?;
    gh.run(
        parent,
        &["repo", "clone", name_with_owner, &dest.to_string_lossy()],
    )?;
    Ok(())
}

pub fn issues_state(gh: &Gh, cwd: &Path) -> Result<IssuesState> {
    let (availability, guidance) = gh.availability(cwd);
    Ok(IssuesState {
        availability,
        guidance,
    })
}

pub fn list_issues(gh: &Gh, cwd: &Path, search: &str) -> Result<Vec<IssueSummary>> {
    gh.require_ready(cwd)?;
    let search = search.trim();
    let mut args = vec!["issue", "list", "--limit", "100", "--json", ISSUE_FIELDS];
    if search.is_empty() {
        args.extend(["--state", "open"]);
    } else {
        args.extend(["--state", "all", "--search", search]);
    }
    let list = parse(&gh.run(cwd, &args)?)?;
    Ok(list
        .as_array()
        .map(|issues| issues.iter().map(issue_summary_from).collect())
        .unwrap_or_default())
}

pub fn issue_detail(gh: &Gh, cwd: &Path, number: u32) -> Result<IssueDetail> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let v = parse(&gh.run(cwd, &["issue", "view", &n, "--json", ISSUE_DETAIL_FIELDS])?)?;
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    Ok(IssueDetail {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: text(&v["title"]),
        body: text(&v["body"]),
        state: text(&v["state"]),
        author: text(&v["author"]["login"]),
        url: text(&v["url"]),
        created_at: text(&v["createdAt"]),
        comments: list("comments")
            .iter()
            .map(|c| IssueComment {
                author: text(&c["author"]["login"]),
                body: text(&c["body"]),
                created_at: text(&c["createdAt"]),
            })
            .collect(),
    })
}

pub fn create_issue(gh: &Gh, cwd: &Path, title: &str, body: &str) -> Result<IssueSummary> {
    gh.require_ready(cwd)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Github("Write an issue title.".into()));
    }
    let output = gh.run(cwd, &["issue", "create", "--title", title, "--body", body])?;
    let url = output.trim();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    let detail = issue_detail(gh, cwd, number)?;
    Ok(IssueSummary {
        number: detail.number,
        title: detail.title,
        state: detail.state,
        author: detail.author,
        url: detail.url,
        comments_count: 0,
        created_at: detail.created_at,
    })
}

pub fn comment_issue(gh: &Gh, cwd: &Path, number: u32, body: &str) -> Result<()> {
    let body = body.trim();
    if body.is_empty() {
        return Err(Error::Github("Write a comment first.".into()));
    }
    gh.require_ready(cwd)?;
    gh.run(
        cwd,
        &["issue", "comment", &number.to_string(), "--body", body],
    )?;
    Ok(())
}

pub fn close_issue(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["issue", "close", &number.to_string()])?;
    Ok(())
}

pub fn issue_url(gh: &Gh, cwd: &Path, number: u32) -> Result<String> {
    let detail = issue_detail(gh, cwd, number)?;
    if !detail.url.starts_with("https://") {
        return Err(Error::Github(format!(
            "refusing to open unexpected issue URL: {}",
            detail.url
        )));
    }
    Ok(detail.url)
}
