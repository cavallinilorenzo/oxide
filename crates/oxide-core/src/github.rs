//! GitHub through the `gh` CLI. The token never leaves `gh`, and the repository
//! is whatever `gh` resolves from the checkout. Nothing here runs unless the
//! user asked: there is no polling.

use crate::git;
use crate::git_diff::{Diff, parse_patch};
use crate::{Error, Result};
use oxide_provider::command::find_in;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const INSTALL_GUIDANCE: &str =
    "Install the GitHub CLI (https://cli.github.com), then run `gh auth login`.";
const LOGIN_GUIDANCE: &str = "The GitHub CLI is not logged in. Run `gh auth login` in a terminal.";

/// How long a passing `gh auth status`, and a repository's default branch, are reused.
/// Each costs a round trip to GitHub, and the Pull request Surface needs both on every load.
const CACHE_TTL: Duration = Duration::from_secs(300);

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
    pub created_at: String,
}

/// Where a pull request stands, as a Board card shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestPhase {
    Draft,
    Open,
    Merged,
    Closed,
}

/// A Board Thread's pull request: its number, state and a tally of its checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPullRequest {
    pub number: u32,
    pub url: String,
    pub phase: PullRequestPhase,
    pub checks_passed: u32,
    pub checks_failed: u32,
    pub checks_pending: u32,
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
    /// Where GitHub shows the run, to find out why it failed.
    pub url: Option<String>,
    /// Whether branch protection requires it to pass before merging. GitHub's merge box counts
    /// only these, so a matrix job or an optional check does not hold the merge up.
    pub required: bool,
}

/// Whether the pull request can be merged as it is, as GitHub's merge box decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeState {
    Clean,
    /// The branch conflicts with its base.
    Conflicting,
    /// The base has moved on.
    Behind,
    /// Required reviews or checks are missing.
    Blocked,
    /// Checks that are not required are failing.
    Unstable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    /// Asked for a review, has not given one.
    Requested,
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReviewer {
    pub login: String,
    pub state: ReviewState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestLabel {
    pub name: String,
    /// Hex without the `#`.
    pub color: String,
}

/// A conversation entry: a comment, or a review that said something.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Set when the entry is a review rather than a plain comment.
    pub review: Option<ReviewState>,
}

/// Who and what a pull request can be assigned, for the settings pickers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCandidates {
    pub users: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
}

/// Changes to a pull request's reviewers, assignees and labels.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestEdit {
    pub add_reviewers: Vec<String>,
    pub remove_reviewers: Vec<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

/// Everything the Pull request Surface shows for one pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub pull_request: PullRequest,
    pub phase: PullRequestPhase,
    pub body: String,
    pub checks: Vec<PullRequestCheck>,
    pub comments: Vec<PullRequestComment>,
    pub merge_state: MergeState,
    pub review_decision: Option<ReviewDecision>,
    pub reviewers: Vec<PullRequestReviewer>,
    pub assignees: Vec<String>,
    pub labels: Vec<PullRequestLabel>,
    pub additions: u32,
    pub deletions: u32,
    /// The signed-in GitHub user.
    pub viewer: String,
    /// The merge methods the repository allows.
    pub merge_methods: Vec<MergeMethod>,
    /// The method GitHub's own merge box would preselect for the user.
    pub default_merge_method: Option<MergeMethod>,
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
/// Only success is cached: a missing or logged-out `gh` is checked again every time.
#[derive(Default)]
pub struct Gh {
    search_path: Mutex<Option<Vec<PathBuf>>>,
    ready_at: Mutex<Option<Instant>>,
    default_branches: Mutex<HashMap<PathBuf, (Instant, String)>>,
}

impl Gh {
    pub fn set_search_path(&self, dirs: Option<Vec<PathBuf>>) {
        *self.search_path.lock().unwrap_or_else(|e| e.into_inner()) = dirs;
        *self.ready_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.default_branches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
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
        #[cfg(windows)]
        let mut child_path = path.clone();
        #[cfg(windows)]
        if self
            .search_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
            && let Some(inherited_path) = std::env::var_os("PATH")
        {
            // The test shim is found through the explicit search path, but its .cmd launcher
            // needs tools such as Python from the runner's PATH.
            child_path.push(";");
            child_path.push(inherited_path);
        }
        #[cfg(not(windows))]
        let child_path = path.clone();
        let mut command = Command::new(
            find_in(
                &path,
                std::ffi::OsStr::new("gh"),
                std::env::var_os("PATHEXT").as_deref(),
            )
            .ok_or(GhError::Missing)?,
        );
        // cmd.exe cannot safely carry newlines in a batch argument. gh accepts body text
        // on stdin, preserving descriptions and comments when it is installed as a shim.
        #[cfg(windows)]
        let mut args = args.to_vec();
        #[cfg(windows)]
        let body = args.iter().position(|arg| *arg == "--body").and_then(|at| {
            let body = *args.get(at + 1)?;
            if !body.contains(['\r', '\n']) {
                return None;
            }
            args[at] = "--body-file";
            args[at + 1] = "-";
            Some(body)
        });
        command
            .args(args)
            .current_dir(cwd)
            .env("PATH", &child_path)
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null());
        #[cfg(windows)]
        let output = if let Some(body) = body {
            use std::io::Write;
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            command.spawn().and_then(|mut child| {
                let sent = child.stdin.take().unwrap().write_all(body.as_bytes());
                let output = child.wait_with_output();
                sent.and(output)
            })
        } else {
            command.output()
        };
        #[cfg(not(windows))]
        let output = command.output();
        let output = output.map_err(|e| match e.kind() {
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
        let fresh = |at: &Option<Instant>| at.is_some_and(|at| at.elapsed() < CACHE_TTL);
        if fresh(&self.ready_at.lock().unwrap_or_else(|e| e.into_inner())) {
            return (GithubAvailability::Ready, None);
        }
        match self.run(cwd, &["auth", "status"]) {
            Ok(_) => {
                *self.ready_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                (GithubAvailability::Ready, None)
            }
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
        if let Some((at, branch)) = self
            .default_branches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(cwd)
            && at.elapsed() < CACHE_TTL
        {
            return Ok(branch.clone());
        }
        let json = self.run(cwd, &["repo", "view", "--json", "defaultBranchRef"])?;
        let value: serde_json::Value = parse(&json)?;
        let branch = value["defaultBranchRef"]["name"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| Error::Github("GitHub did not report a default branch.".into()))?;
        self.default_branches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cwd.to_path_buf(), (Instant::now(), branch.clone()));
        Ok(branch)
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

const PR_FIELDS: &str = "number,title,url,state,isDraft,baseRefName,headRefName,author,createdAt";

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
        created_at: text(&v["createdAt"]),
    }
}

fn phase_from(v: &serde_json::Value) -> PullRequestPhase {
    match v["state"].as_str() {
        Some("MERGED") => PullRequestPhase::Merged,
        Some("CLOSED") => PullRequestPhase::Closed,
        _ if v["isDraft"].as_bool() == Some(true) => PullRequestPhase::Draft,
        _ => PullRequestPhase::Open,
    }
}

fn merge_state_from(v: &serde_json::Value) -> MergeState {
    if v["mergeable"].as_str() == Some("CONFLICTING") {
        return MergeState::Conflicting;
    }
    match v["mergeStateStatus"].as_str() {
        Some("DIRTY") => MergeState::Conflicting,
        Some("BEHIND") => MergeState::Behind,
        Some("BLOCKED") => MergeState::Blocked,
        Some("UNSTABLE") => MergeState::Unstable,
        Some("CLEAN" | "HAS_HOOKS") => MergeState::Clean,
        _ => MergeState::Unknown,
    }
}

fn review_state_from(state: Option<&str>) -> Option<ReviewState> {
    match state? {
        "APPROVED" => Some(ReviewState::Approved),
        "CHANGES_REQUESTED" => Some(ReviewState::ChangesRequested),
        "COMMENTED" => Some(ReviewState::Commented),
        "DISMISSED" => Some(ReviewState::Dismissed),
        _ => None,
    }
}

/// People asked for a review, and the latest verdict of those who gave one.
fn reviewers_from(v: &serde_json::Value) -> Vec<PullRequestReviewer> {
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    let mut reviewers: Vec<PullRequestReviewer> = Vec::new();
    for review in list("latestReviews") {
        if let Some(state) = review_state_from(review["state"].as_str()) {
            reviewers.push(PullRequestReviewer {
                login: text(&review["author"]["login"]),
                state,
            });
        }
    }
    for request in list("reviewRequests") {
        // A user has a `login`, a team a `name`.
        let login = request["login"]
            .as_str()
            .or_else(|| request["name"].as_str())
            .unwrap_or_default()
            .to_string();
        // A new request overrides the earlier verdict of the same person.
        reviewers.retain(|r| r.login != login);
        reviewers.push(PullRequestReviewer {
            login,
            state: ReviewState::Requested,
        });
    }
    reviewers
}

fn labels_from(value: &serde_json::Value) -> Vec<PullRequestLabel> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| PullRequestLabel {
            name: text(&l["name"]),
            color: text(&l["color"]),
        })
        .collect()
}

/// Comments and the reviews that said something, oldest first, as the web conversation shows them.
fn conversation_from(v: &serde_json::Value) -> Vec<PullRequestComment> {
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    let mut entries: Vec<PullRequestComment> = list("comments")
        .iter()
        .map(|c| PullRequestComment {
            author: text(&c["author"]["login"]),
            body: text(&c["body"]),
            created_at: text(&c["createdAt"]),
            review: None,
        })
        .collect();
    for review in list("reviews") {
        let Some(state) = review_state_from(review["state"].as_str()) else {
            continue;
        };
        let body = text(&review["body"]);
        if body.trim().is_empty() && state == ReviewState::Commented {
            continue;
        }
        entries.push(PullRequestComment {
            author: text(&review["author"]["login"]),
            body,
            created_at: text(&review["submittedAt"]),
            review: Some(state),
        });
    }
    entries.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    entries
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
        // Check runs have a `detailsUrl`, commit statuses a `targetUrl`.
        url: v["detailsUrl"]
            .as_str()
            .or_else(|| v["targetUrl"].as_str())
            .filter(|url| url.starts_with("https://"))
            .map(str::to_string),
        required: false,
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
        // Two independent round trips to GitHub: run them side by side.
        let (default_branch, pull_request) = std::thread::scope(|scope| {
            let pull_request = state
                .branch
                .is_some()
                .then(|| scope.spawn(|| gh.current_pull_request(cwd)));
            let default_branch = gh.default_branch(cwd);
            let pull_request = match pull_request {
                Some(handle) => handle
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic)),
                None => Ok(None),
            };
            (default_branch, pull_request)
        });
        state.default_branch = Some(default_branch?);
        state.pull_request = pull_request?;
    }
    Ok(state)
}

/// Branches that exist in the GitHub repository, including pages beyond the first.
/// Local-only branches cannot receive a pull request.
pub fn pull_request_base_branches(gh: &Gh, cwd: &Path) -> Result<Vec<String>> {
    gh.require_ready(cwd)?;
    let names = gh.run(
        cwd,
        &[
            "api",
            "repos/{owner}/{repo}/branches?per_page=100",
            "--paginate",
            "--jq",
            ".[].name",
        ],
    )?;
    let mut branches: Vec<String> = names
        .lines()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect();
    branches.sort();
    branches.dedup();
    Ok(branches)
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

/// The pull request of `branch`, whatever its state: an open one if there is one, else the
/// latest. `None` when the branch has none.
pub fn branch_pull_request(gh: &Gh, cwd: &Path, branch: &str) -> Result<Option<BranchPullRequest>> {
    gh.require_ready(cwd)?;
    let fields = format!("{PR_FIELDS},statusCheckRollup");
    let list = parse(&gh.run(
        cwd,
        &[
            "pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json", &fields,
        ],
    )?)?;
    let prs = list.as_array().cloned().unwrap_or_default();
    let open = |v: &&serde_json::Value| v["state"].as_str() == Some("OPEN");
    let Some(v) = prs
        .iter()
        .filter(open)
        .max_by_key(|v| v["number"].as_u64())
        .or_else(|| prs.iter().max_by_key(|v| v["number"].as_u64()))
    else {
        return Ok(None);
    };
    let phase = phase_from(v);
    let mut tally = [0u32; 3];
    for check in v["statusCheckRollup"].as_array().into_iter().flatten() {
        tally[match check_from(check).state {
            CheckState::Success => 0,
            CheckState::Failure => 1,
            CheckState::Pending => 2,
        }] += 1;
    }
    Ok(Some(BranchPullRequest {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        url: text(&v["url"]),
        phase,
        checks_passed: tally[0],
        checks_failed: tally[1],
        checks_pending: tally[2],
    }))
}

/// One pull request with its description, checks, conversation, the merge
/// methods the repository allows and its changed files.
pub fn pull_request_detail(gh: &Gh, cwd: &Path, number: u32) -> Result<PullRequestDetail> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let fields = format!(
        "{PR_FIELDS},body,comments,reviews,latestReviews,reviewRequests,assignees,labels,\
         additions,deletions,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"
    );
    // Independent round trips to GitHub: run them side by side.
    let (view, settings, patch, default_method, viewer, required) = std::thread::scope(|scope| {
        let required = scope.spawn(|| required_check_names(gh, cwd, number));
        let settings = scope.spawn(|| merge_settings(gh, cwd));
        let patch = scope.spawn(|| gh.run(cwd, &["pr", "diff", &n, "--color=never"]));
        let default_method = scope.spawn(|| viewer_default_merge_method(gh, cwd));
        let viewer = scope.spawn(|| viewer_login(gh, cwd));
        let view = gh.run(cwd, &["pr", "view", &n, "--json", &fields]);
        fn join<T>(handle: std::thread::ScopedJoinHandle<'_, T>) -> T {
            handle
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
        }
        (
            view,
            join(settings),
            join(patch),
            join(default_method),
            join(viewer),
            join(required),
        )
    });
    let v = parse(&view?)?;
    let (merge_methods, delete_branch_on_merge) = settings?;
    let patch = patch?;

    let pull_request = pull_request_from(&v);
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    Ok(PullRequestDetail {
        phase: phase_from(&v),
        body: text(&v["body"]),
        checks: list("statusCheckRollup")
            .iter()
            .map(|v| {
                let mut check = check_from(v);
                check.required = required.contains(&check.name);
                check
            })
            .collect(),
        comments: conversation_from(&v),
        merge_state: merge_state_from(&v),
        review_decision: match v["reviewDecision"].as_str() {
            Some("APPROVED") => Some(ReviewDecision::Approved),
            Some("CHANGES_REQUESTED") => Some(ReviewDecision::ChangesRequested),
            Some("REVIEW_REQUIRED") => Some(ReviewDecision::ReviewRequired),
            _ => None,
        },
        reviewers: reviewers_from(&v),
        assignees: list("assignees")
            .iter()
            .map(|a| text(&a["login"]))
            .collect(),
        labels: labels_from(&v["labels"]),
        additions: v["additions"].as_u64().unwrap_or(0) as u32,
        deletions: v["deletions"].as_u64().unwrap_or(0) as u32,
        viewer: viewer.unwrap_or_default(),
        default_merge_method: default_method.filter(|m| merge_methods.contains(m)),
        merge_methods,
        delete_branch_on_merge,
        diff: Diff {
            base: Some(pull_request.base.clone()),
            files: parse_patch(&patch),
        },
        pull_request,
    })
}

/// The names of the checks branch protection requires of this pull request, from the latest
/// commit's rollup. Empty when GitHub does not say, so every check then counts.
fn required_check_names(gh: &Gh, cwd: &Path, number: u32) -> Vec<String> {
    let query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){\
        pullRequest(number:$number){commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{\
        __typename ... on CheckRun{name isRequired(pullRequestNumber:$number)} \
        ... on StatusContext{context isRequired(pullRequestNumber:$number)}}}}}}}}}}";
    let jq = ".data.repository.pullRequest.commits.nodes[].commit.statusCheckRollup.contexts.nodes[] \
        | select(.isRequired) | .name // .context";
    let number = format!("number={number}");
    let query = format!("query={query}");
    gh.run(
        cwd,
        &[
            "api",
            "graphql",
            "-F",
            "owner={owner}",
            "-F",
            "name={repo}",
            "-F",
            &number,
            "-f",
            &query,
            "--jq",
            jq,
        ],
    )
    .map(|out| out.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

/// The method the web merge box preselects for the signed-in user, if GitHub says.
fn viewer_default_merge_method(gh: &Gh, cwd: &Path) -> Option<MergeMethod> {
    let out = gh
        .run(
            cwd,
            &[
                "api",
                "graphql",
                "-F",
                "owner={owner}",
                "-F",
                "name={repo}",
                "-f",
                "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerDefaultMergeMethod}}",
                "--jq",
                ".data.repository.viewerDefaultMergeMethod",
            ],
        )
        .ok()?;
    match out.trim() {
        "MERGE" => Some(MergeMethod::Merge),
        "SQUASH" => Some(MergeMethod::Squash),
        "REBASE" => Some(MergeMethod::Rebase),
        _ => None,
    }
}

fn viewer_login(gh: &Gh, cwd: &Path) -> Option<String> {
    let out = gh.run(cwd, &["api", "user", "--jq", ".login"]).ok()?;
    Some(out.trim().to_string()).filter(|login| !login.is_empty())
}

/// Moves a pull request out of draft, or back into it.
pub fn set_pull_request_draft(gh: &Gh, cwd: &Path, number: u32, draft: bool) -> Result<()> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let mut args = vec!["pr", "ready", &n];
    if draft {
        args.push("--undo");
    }
    gh.run(cwd, &args)?;
    Ok(())
}

/// Merges the base branch into the pull request's branch.
pub fn update_pull_request_branch(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["pr", "update-branch", &number.to_string()])?;
    Ok(())
}

/// Who can review or be assigned, and the labels the repository has.
pub fn pull_request_candidates(gh: &Gh, cwd: &Path) -> Result<PullRequestCandidates> {
    gh.require_ready(cwd)?;
    let repo = parse(&gh.run(cwd, &["repo", "view", "--json", "assignableUsers,labels"])?)?;
    let mut users: Vec<String> = repo["assignableUsers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|u| text(&u["login"]))
        .collect();
    users.sort_by_key(|u| u.to_lowercase());
    Ok(PullRequestCandidates {
        users,
        labels: labels_from(&repo["labels"]),
    })
}

/// Applies the changes to reviewers, assignees and labels in one `gh` call.
pub fn edit_pull_request(gh: &Gh, cwd: &Path, number: u32, edit: &PullRequestEdit) -> Result<()> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let joined: Vec<(&str, String)> = [
        ("--add-reviewer", &edit.add_reviewers),
        ("--remove-reviewer", &edit.remove_reviewers),
        ("--add-assignee", &edit.add_assignees),
        ("--remove-assignee", &edit.remove_assignees),
        ("--add-label", &edit.add_labels),
        ("--remove-label", &edit.remove_labels),
    ]
    .into_iter()
    .filter(|(_, names)| !names.is_empty())
    .map(|(flag, names)| (flag, names.join(",")))
    .collect();
    if joined.is_empty() {
        return Ok(());
    }
    let mut args = vec!["pr", "edit", &n];
    for (flag, value) in &joined {
        args.extend([*flag, value.as_str()]);
    }
    gh.run(cwd, &args)?;
    Ok(())
}

/// A link for the system browser, which only ever gets `https`.
pub fn checked_url(url: &str) -> Result<&str> {
    if url.starts_with("https://") {
        Ok(url)
    } else {
        Err(Error::Github(format!("Unexpected link: {url}")))
    }
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

/// Merges with a method the repository allows, or with `auto` turns on
/// auto-merge: GitHub merges once the required checks pass, and deletes the
/// branch itself if the repository is set to. The caller holds the checkout's
/// Git lock: deleting the branch may move the checkout off it.
pub fn merge_pull_request(
    gh: &Gh,
    cwd: &Path,
    number: u32,
    method: MergeMethod,
    delete_branch: bool,
    auto: bool,
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
    if auto {
        args.push("--auto");
    } else if delete_branch {
        args.push("--delete-branch");
    }
    gh.run(cwd, &args)?;
    Ok(())
}

/// Closes a pull request without merging it, leaving the base branch alone.
pub fn close_pull_request(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["pr", "close", &number.to_string()])?;
    Ok(())
}

/// Checks the pull request's branch out in `cwd`. Git's refusal is the error.
pub fn checkout_pull_request(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["pr", "checkout", &number.to_string()])?;
    Ok(())
}

const ISSUE_FIELDS: &str =
    "number,title,state,stateReason,author,url,createdAt,comments,labels,assignees";
const ISSUE_DETAIL_FIELDS: &str =
    "number,title,body,state,stateReason,author,url,createdAt,comments,labels,assignees";

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
    /// `OPEN` or `CLOSED`.
    pub state: String,
    /// Why a closed issue was closed: `COMPLETED` or `NOT_PLANNED`; empty while open.
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub comments_count: u32,
    pub created_at: String,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_reason: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub comments: Vec<IssueComment>,
    pub labels: Vec<PullRequestLabel>,
    pub assignees: Vec<String>,
    /// The signed-in GitHub user.
    pub viewer: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuesState {
    pub availability: GithubAvailability,
    pub guidance: Option<String>,
}

/// Why an issue is closed, as the web's close menu offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueCloseReason {
    Completed,
    NotPlanned,
}

/// One file of the repository's `.github/ISSUE_TEMPLATE` directory, `config.yml` included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplateFile {
    pub name: String,
    pub content: String,
}

/// Changes to an issue's text, assignees and labels; `None` leaves the text alone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueEdit {
    pub title: Option<String>,
    pub body: Option<String>,
    pub add_assignees: Vec<String>,
    pub remove_assignees: Vec<String>,
    pub add_labels: Vec<String>,
    pub remove_labels: Vec<String>,
}

fn issue_summary_from(v: &serde_json::Value) -> IssueSummary {
    IssueSummary {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: text(&v["title"]),
        state: text(&v["state"]),
        state_reason: text(&v["stateReason"]),
        author: text(&v["author"]["login"]),
        url: text(&v["url"]),
        comments_count: v["comments"].as_array().map(|c| c.len()).unwrap_or(0) as u32,
        created_at: text(&v["createdAt"]),
        labels: labels_from(&v["labels"]),
        assignees: logins_from(&v["assignees"]),
    }
}

fn logins_from(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| text(&a["login"]))
        .collect()
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

/// Issues of the repository, open or closed, optionally only those the user opened and
/// narrowed by a search query.
pub fn list_issues(
    gh: &Gh,
    cwd: &Path,
    closed: bool,
    mine: bool,
    search: &str,
) -> Result<Vec<IssueSummary>> {
    gh.require_ready(cwd)?;
    let search = search.trim();
    let mut args = vec![
        "issue",
        "list",
        "--limit",
        MAX_LISTED,
        "--json",
        ISSUE_FIELDS,
        "--state",
        if closed { "closed" } else { "open" },
    ];
    if mine {
        args.extend(["--author", "@me"]);
    }
    if !search.is_empty() {
        args.extend(["--search", search]);
    }
    let list = parse(&gh.run(cwd, &args)?)?;
    Ok(list
        .as_array()
        .map(|issues| issues.iter().map(issue_summary_from).collect())
        .unwrap_or_default())
}

/// The issue templates the repository offers on GitHub, as the files they are written in.
/// Parsing stays with the caller: the YAML forms and Markdown templates are the web's format.
pub fn issue_templates(gh: &Gh, cwd: &Path) -> Result<Vec<IssueTemplateFile>> {
    gh.require_ready(cwd)?;
    const DIR: &str = "repos/{owner}/{repo}/contents/.github/ISSUE_TEMPLATE";
    let listing = match gh.run(
        cwd,
        &[
            "api",
            DIR,
            "--jq",
            r#".[] | select(.type == "file") | .name"#,
        ],
    ) {
        Ok(listing) => listing,
        // No such directory: the repository has no templates, which is not a failure.
        Err(GhError::Failed(message))
            if message.contains("Not Found") || message.contains("404") =>
        {
            return Ok(Vec::new());
        }
        Err(e) => return Err(e.into()),
    };
    let names: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|name| {
            let name = name.to_ascii_lowercase();
            [".yml", ".yaml", ".md"]
                .iter()
                .any(|ext| name.ends_with(ext))
        })
        .collect();
    let fetched: Vec<Result<IssueTemplateFile>> = std::thread::scope(|scope| {
        let handles: Vec<_> = names
            .iter()
            .map(|name| {
                scope.spawn(move || {
                    let path = format!("{DIR}/{name}");
                    let content = gh.run(
                        cwd,
                        &[
                            "api",
                            &path,
                            "-H",
                            "Accept: application/vnd.github.raw+json",
                        ],
                    )?;
                    Ok(IssueTemplateFile {
                        name: (*name).to_string(),
                        content,
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    });
    let mut files = fetched.into_iter().collect::<Result<Vec<_>>>()?;
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

pub fn issue_detail(gh: &Gh, cwd: &Path, number: u32) -> Result<IssueDetail> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let (view, viewer) = std::thread::scope(|scope| {
        let viewer = scope.spawn(|| viewer_login(gh, cwd));
        let view = gh.run(cwd, &["issue", "view", &n, "--json", ISSUE_DETAIL_FIELDS]);
        (
            view,
            viewer
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic)),
        )
    });
    let v = parse(&view?)?;
    let list = |key: &str| v[key].as_array().cloned().unwrap_or_default();
    Ok(IssueDetail {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: text(&v["title"]),
        body: text(&v["body"]),
        state: text(&v["state"]),
        state_reason: text(&v["stateReason"]),
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
        labels: labels_from(&v["labels"]),
        assignees: logins_from(&v["assignees"]),
        viewer: viewer.unwrap_or_default(),
    })
}

pub fn create_issue(
    gh: &Gh,
    cwd: &Path,
    title: &str,
    body: &str,
    assignees: &[String],
    labels: &[String],
) -> Result<IssueSummary> {
    gh.require_ready(cwd)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(Error::Github("Write an issue title.".into()));
    }
    let assignees = assignees.join(",");
    let labels = labels.join(",");
    let mut args = vec!["issue", "create", "--title", title, "--body", body];
    if !assignees.is_empty() {
        args.extend(["--assignee", &assignees]);
    }
    if !labels.is_empty() {
        args.extend(["--label", &labels]);
    }
    let output = gh.run(cwd, &args)?;
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
        state_reason: detail.state_reason,
        author: detail.author,
        url: detail.url,
        comments_count: 0,
        created_at: detail.created_at,
        labels: detail.labels,
        assignees: detail.assignees,
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

/// Closes an issue with a reason, and a comment when there is one to leave.
pub fn close_issue(
    gh: &Gh,
    cwd: &Path,
    number: u32,
    reason: IssueCloseReason,
    comment: &str,
) -> Result<()> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let comment = comment.trim();
    let mut args = vec![
        "issue",
        "close",
        &n,
        "--reason",
        match reason {
            IssueCloseReason::Completed => "completed",
            IssueCloseReason::NotPlanned => "not planned",
        },
    ];
    if !comment.is_empty() {
        args.extend(["--comment", comment]);
    }
    gh.run(cwd, &args)?;
    Ok(())
}

pub fn reopen_issue(gh: &Gh, cwd: &Path, number: u32) -> Result<()> {
    gh.require_ready(cwd)?;
    gh.run(cwd, &["issue", "reopen", &number.to_string()])?;
    Ok(())
}

/// Applies the changes to title, description, assignees and labels in one `gh` call.
pub fn edit_issue(gh: &Gh, cwd: &Path, number: u32, edit: &IssueEdit) -> Result<()> {
    gh.require_ready(cwd)?;
    let n = number.to_string();
    let title = edit.title.as_deref().map(str::trim);
    if title == Some("") {
        return Err(Error::Github("Write an issue title.".into()));
    }
    let mut flags: Vec<(&str, String)> = Vec::new();
    if let Some(title) = title {
        flags.push(("--title", title.to_string()));
    }
    if let Some(body) = &edit.body {
        flags.push(("--body", body.clone()));
    }
    for (flag, names) in [
        ("--add-assignee", &edit.add_assignees),
        ("--remove-assignee", &edit.remove_assignees),
        ("--add-label", &edit.add_labels),
        ("--remove-label", &edit.remove_labels),
    ] {
        if !names.is_empty() {
            flags.push((flag, names.join(",")));
        }
    }
    if flags.is_empty() {
        return Ok(());
    }
    let mut args = vec!["issue", "edit", &n];
    for (flag, value) in &flags {
        args.extend([*flag, value.as_str()]);
    }
    gh.run(cwd, &args)?;
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
