//! The Review ledger: how long finished work waits for its merge, kept after the Thread is gone.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use oxide_core::{Core, DispatchRequest, MergeMethod, ReviewLedger};
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
    let work = tmp.path().join("scan").join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "x\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let gh_dir = tmp.path().join("gh");
    std::fs::create_dir_all(&gh_dir).unwrap();
    for name in ["gh", "gh.cmd", "gh.py"] {
        std::fs::copy(Path::new(FAKE_GH_DIR).join(name), gh_dir.join(name)).unwrap();
    }
    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    let project = core.add_project(&work.to_string_lossy()).unwrap().id;
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

    /// A Board Thread whose first Turn has finished.
    fn finished_thread(&self, prompt: &str) -> oxide_core::thread::ThreadSummary {
        let thread = self
            .core
            .dispatch_thread(DispatchRequest {
                project_id: self.project,
                prompt: prompt.into(),
                provider: "fake".into(),
                model: Some("fake-model".into()),
                effort: None,
                permission_mode: None,
                base_branch: Some("main".into()),
                issue_number: None,
                issue_title: None,
                issue_url: None,
            })
            .unwrap();
        // The Turn itself must be stored as completed, not just the Thread's status shown so.
        wait_until(|| {
            self.core
                .list_turns(thread.id, 0, 10)
                .map(|page| {
                    page.turns.iter().any(|t| {
                        t.status == oxide_core::TurnStatus::Completed && t.completed_at.is_some()
                    })
                })
                .unwrap_or(false)
        });
        thread
    }

    fn ledger(&self) -> ReviewLedger {
        self.core.review_ledger(self.project).unwrap()
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn pr(branch: &str, number: u32, state: &str, merged_at: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "number": number, "title": "t", "url": format!("https://github.com/fake/repo/pull/{number}"),
        "state": state, "isDraft": false, "baseRefName": "main", "headRefName": branch,
        "author": {"login": "me"}, "statusCheckRollup": [], "mergedAt": merged_at,
    })
}

const LATER: &str = "2099-01-01T00:00:00Z";

/// A Thread with a merged pull request on its branch, seen by opening the Board.
fn merged_thread(f: &Fixture, prompt: &str) -> oxide_core::thread::ThreadSummary {
    let thread = f.finished_thread(prompt);
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 4, "MERGED", Some(LATER)) },
    }));
    let _board = f.core.subscribe_board(f.project).unwrap();
    wait_until(|| !f.ledger().entries.is_empty());
    thread
}

#[test]
fn an_empty_ledger_has_no_median() {
    let f = fixture();
    let ledger = f.ledger();
    assert!(ledger.entries.is_empty());
    assert_eq!(ledger.median_secs, None);
}

#[test]
fn a_merge_seen_on_the_board_refresh_is_recorded_without_transcript_text() {
    let f = fixture();
    let thread = merged_thread(&f, "Add the secret search feature");

    let ledger = f.ledger();
    assert_eq!(ledger.entries.len(), 1);
    let entry = &ledger.entries[0];
    assert_eq!(entry.thread_id, thread.id);
    assert_eq!(entry.pull_request, 4);
    assert_eq!(entry.provider, "fake");
    assert_eq!(entry.model.as_deref(), Some("fake-model"));
    assert!(entry.merged_at > entry.turn_completed_at);
    assert_eq!(
        ledger.median_secs,
        Some(entry.merged_at - entry.turn_completed_at)
    );
    let serialized = serde_json::to_string(&ledger).unwrap();
    assert!(!serialized.contains("secret search"), "{serialized}");
}

#[test]
fn seeing_the_same_merge_twice_records_it_once() {
    let f = fixture();
    merged_thread(&f, "Add search");

    let _again = f.core.subscribe_board(f.project).unwrap();
    std::thread::sleep(Duration::from_secs(2));

    assert_eq!(f.ledger().entries.len(), 1);
}

#[test]
fn a_pull_request_that_is_still_open_records_nothing() {
    let f = fixture();
    let thread = f.finished_thread("Add search");
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 4, "OPEN", None) },
    }));

    let _board = f.core.subscribe_board(f.project).unwrap();
    std::thread::sleep(Duration::from_secs(2));

    assert!(f.ledger().entries.is_empty());
}

#[test]
fn a_merge_dated_before_any_finished_turn_records_nothing() {
    let f = fixture();
    let thread = f.finished_thread("Add search");
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 4, "MERGED", Some("2001-01-01T00:00:00Z")) },
    }));

    let _board = f.core.subscribe_board(f.project).unwrap();
    std::thread::sleep(Duration::from_secs(2));

    assert!(f.ledger().entries.is_empty());
}

#[test]
fn a_merge_made_through_oxide_is_recorded() {
    let f = fixture();
    let thread = f.finished_thread("Add search");
    let branch = thread.branch.clone().unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok",
        "prs": { branch.clone(): pr(&branch, 4, "OPEN", None) },
    }));

    f.core
        .merge_pull_request(f.project, 4, MergeMethod::Squash, false, false)
        .unwrap();

    let ledger = f.ledger();
    assert_eq!(ledger.entries.len(), 1);
    assert_eq!(ledger.entries[0].thread_id, thread.id);
    assert_eq!(ledger.entries[0].pull_request, 4);
}

#[test]
fn deleting_the_thread_keeps_its_entry() {
    let f = fixture();
    let thread = merged_thread(&f, "Add search");
    let before = f.ledger();

    f.core.delete_thread(thread.id, true).unwrap();

    assert!(f.core.list_threads(f.project).unwrap().is_empty());
    assert_eq!(f.ledger(), before);
}

#[test]
fn clearing_removes_every_entry() {
    let f = fixture();
    merged_thread(&f, "Add search");

    f.core.clear_review_ledger().unwrap();

    let ledger = f.ledger();
    assert!(ledger.entries.is_empty());
    assert_eq!(ledger.median_secs, None);
}
