use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use oxide_core::{BoardEvent, Core, DispatchRequest, PullRequestPhase};
use tempfile::TempDir;

const FAKE_GH_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/gh");

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: u32,
    gh_dir: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let scan = tmp.path().join("scan");
    let work = scan.join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "x\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    // The fake keeps its state next to the script: work on a copy.
    let gh_dir = tmp.path().join("gh");
    std::fs::create_dir_all(&gh_dir).unwrap();
    for name in ["gh", "gh.py"] {
        std::fs::copy(Path::new(FAKE_GH_DIR).join(name), gh_dir.join(name)).unwrap();
    }
    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    let project = core.rescan_projects().unwrap().remove(0).id;
    Fixture {
        _tmp: tmp,
        core,
        project,
        gh_dir,
    }
}

impl Fixture {
    fn set_gh(&self, state: serde_json::Value) {
        std::fs::write(self.gh_dir.join("state.json"), state.to_string()).unwrap();
    }

    fn dispatch(&self, prompt: &str) -> oxide_core::thread::ThreadSummary {
        self.core
            .dispatch_thread(DispatchRequest {
                project_id: self.project,
                prompt: prompt.into(),
                provider: "fake".into(),
                model: None,
                effort: None,
                permission_mode: None,
                base_branch: Some("main".into()),
                issue_number: None,
                issue_title: None,
            })
            .unwrap()
    }
}

fn pr(
    branch: &str,
    number: u32,
    state: &str,
    draft: bool,
    checks: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "number": number, "title": "t", "url": format!("https://github.com/fake/repo/pull/{number}"),
        "state": state, "isDraft": draft, "baseRefName": "main", "headRefName": branch,
        "author": {"login": "me"}, "statusCheckRollup": checks,
    })
}

/// Long enough for the off-thread lookup (two fake `gh` runs, each starting Python) on a slow
/// CI runner. Waiting for an event that does arrive returns as soon as it does.
const ARRIVES_WITHIN: Duration = Duration::from_secs(20);
/// How long to watch before concluding no pull request event is coming.
const QUIET_FOR: Duration = Duration::from_secs(3);

/// The first event for the Thread that carries a pull request, if one arrives within `within`.
fn pull_request_event(
    rx: &crossbeam_channel::Receiver<BoardEvent>,
    thread_id: u32,
    within: Duration,
) -> Option<oxide_core::BoardCard> {
    let deadline = Instant::now() + within;
    while let Ok(BoardEvent::ThreadChanged(card)) = rx.recv_deadline(deadline) {
        if card.thread.id == thread_id && card.pull_request.is_some() {
            return Some(*card);
        }
    }
    None
}

#[test]
fn opening_the_board_shows_each_threads_pull_request_state_and_checks() {
    let f = fixture();
    let thread = f.dispatch("Add search");
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 9, "OPEN", true, serde_json::json!([
            {"__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "name": "web", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS"},
        ])) },
    }));

    let (_, rx) = f.core.subscribe_board(f.project).unwrap();

    let card = pull_request_event(&rx, thread.id, ARRIVES_WITHIN).expect("pull request event");
    let pr = card.pull_request.unwrap();
    assert_eq!(pr.number, 9);
    assert_eq!(pr.phase, PullRequestPhase::Draft);
    assert_eq!(
        (pr.checks_passed, pr.checks_failed, pr.checks_pending),
        (1, 1, 1)
    );
}

#[test]
fn a_merged_pull_request_is_reported_as_merged() {
    let f = fixture();
    let thread = f.dispatch("Add search");
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 4, "MERGED", false, serde_json::json!([])) },
    }));

    let (_, rx) = f.core.subscribe_board(f.project).unwrap();
    let card = pull_request_event(&rx, thread.id, ARRIVES_WITHIN).expect("pull request event");
    assert_eq!(card.pull_request.unwrap().phase, PullRequestPhase::Merged);
}

#[test]
fn threads_without_a_pull_request_or_without_gh_show_nothing_extra() {
    let f = fixture();
    let thread = f.dispatch("Add search");
    f.set_gh(serde_json::json!({ "auth": "ok", "prs": {} }));

    let (snapshot, rx) = f.core.subscribe_board(f.project).unwrap();
    assert!(snapshot.iter().all(|c| c.pull_request.is_none()));
    assert!(pull_request_event(&rx, thread.id, QUIET_FOR).is_none());

    f.set_gh(serde_json::json!({ "auth": "logged_out" }));
    let (_, rx) = f.core.subscribe_board(f.project).unwrap();
    assert!(pull_request_event(&rx, thread.id, QUIET_FOR).is_none());
}
