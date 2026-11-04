//! The Review ledger: how long finished work waits for its merge, kept after the Thread is gone.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use oxide_core::{
    CommentScope, CommentSide, Core, DispatchRequest, MergeMethod, NewLineComment, ReviewLedger,
    ReviewSizeBand,
};
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
        self.finished_thread_with(prompt, None, Vec::new())
    }

    /// A finished Board Thread, linked to an issue with `labels` when one is given.
    fn finished_thread_with(
        &self,
        prompt: &str,
        issue_number: Option<u32>,
        issue_labels: Vec<String>,
    ) -> oxide_core::thread::ThreadSummary {
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
                issue_number,
                issue_title: issue_number.map(|n| format!("Issue {n}")),
                issue_labels,
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

    /// Writes an untracked file into the Thread's worktree, the change a review round sees.
    fn write_change(&self, thread: &oxide_core::thread::ThreadSummary, path: &str, content: &str) {
        let root = PathBuf::from(
            thread
                .worktree_path
                .as_ref()
                .expect("a Board Thread worktree"),
        );
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }

    /// Waits until the Thread's Turn has finished, so another review round can be sent.
    fn wait_completed(&self, thread_id: u32) {
        wait_until(|| {
            self.core
                .list_threads(self.project)
                .unwrap()
                .into_iter()
                .find(|thread| thread.id == thread_id)
                .is_some_and(|thread| thread.status == oxide_core::ThreadStatus::Completed)
        });
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

fn comment(path: &str, code: &str, body: &str) -> NewLineComment {
    NewLineComment {
        scope: CommentScope::Uncommitted,
        path: path.into(),
        side: CommentSide::New,
        line: 1,
        code: code.into(),
        body: body.into(),
    }
}

#[test]
fn each_send_of_line_comments_counts_a_round_by_provider_model_and_kind() {
    let f = fixture();
    let thread = f.finished_thread_with(
        "Add the secret search feature",
        Some(7),
        vec!["backend".into(), "bug".into(), "backend".into()],
    );
    f.write_change(&thread, "src/search.rs", "pub fn search() {}\n");
    f.write_change(
        &thread,
        "web/src/search.ts",
        "export const search = () => null;\n",
    );

    f.core
        .add_line_comment(
            thread.id,
            comment("src/search.rs", "pub fn search() {}", "secret review text"),
        )
        .unwrap();
    f.core.send_line_comments(thread.id).unwrap();
    f.wait_completed(thread.id);

    f.core
        .add_line_comment(
            thread.id,
            comment(
                "web/src/search.ts",
                "export const search = () => null;",
                "again",
            ),
        )
        .unwrap();
    f.core.send_line_comments(thread.id).unwrap();

    let ledger = f.ledger();
    assert_eq!(ledger.rounds.len(), 1);
    let group = &ledger.rounds[0];
    assert_eq!(group.provider, "fake");
    assert_eq!(group.model.as_deref(), Some("fake-model"));
    assert_eq!(group.kind.languages, ["rust", "typescript"]);
    assert_eq!(group.kind.size_band, ReviewSizeBand::Small);
    assert_eq!(group.kind.issue_labels, ["backend", "bug"]);
    assert_eq!(group.sample_size, 2);
    let serialized = serde_json::to_string(&ledger).unwrap();
    assert!(!serialized.contains("secret review text"), "{serialized}");
    assert!(!serialized.contains("search.rs"), "{serialized}");
}

#[test]
fn sending_reviewer_comments_counts_a_round_without_their_text() {
    let f = fixture();
    let thread = f.finished_thread("Add search");
    f.write_change(&thread, "src/search.rs", "pub fn search() {}\n");

    f.core
        .send_reviewer_comments(thread.id, "Reviewer text that must not be stored.")
        .unwrap();

    let ledger = f.ledger();
    assert_eq!(ledger.rounds.len(), 1);
    assert_eq!(ledger.rounds[0].sample_size, 1);
    assert_eq!(ledger.rounds[0].kind.languages, ["rust"]);
    assert_eq!(ledger.rounds[0].sample_size, 1);
    let serialized = serde_json::to_string(&ledger).unwrap();
    assert!(!serialized.contains("Reviewer text"), "{serialized}");
}

#[test]
fn review_rounds_are_grouped_by_kind_of_work() {
    let f = fixture();
    let rust = f.finished_thread("Add the Rust search");
    f.write_change(&rust, "src/search.rs", "pub fn search() {}\n");
    f.core
        .add_line_comment(rust.id, comment("src/search.rs", "pub fn search() {}", "x"))
        .unwrap();
    f.core.send_line_comments(rust.id).unwrap();

    let typescript = f.finished_thread("Add the web search");
    f.write_change(
        &typescript,
        "web/src/search.ts",
        "export const search = () => null;\n",
    );
    f.core
        .add_line_comment(
            typescript.id,
            comment(
                "web/src/search.ts",
                "export const search = () => null;",
                "x",
            ),
        )
        .unwrap();
    f.core.send_line_comments(typescript.id).unwrap();

    let ledger = f.ledger();
    assert_eq!(ledger.rounds.len(), 2);
    assert!(ledger.rounds.iter().all(|group| group.sample_size == 1));
    assert!(
        ledger
            .rounds
            .iter()
            .any(|group| group.kind.languages == ["rust"])
    );
    assert!(
        ledger
            .rounds
            .iter()
            .any(|group| group.kind.languages == ["typescript"])
    );
}

#[test]
fn review_rounds_survive_deleting_the_thread_and_clearing_removes_them() {
    let f = fixture();
    let thread = f.finished_thread("Add search");
    f.write_change(&thread, "src/search.rs", "pub fn search() {}\n");
    f.core
        .add_line_comment(
            thread.id,
            comment("src/search.rs", "pub fn search() {}", "x"),
        )
        .unwrap();
    f.core.send_line_comments(thread.id).unwrap();
    let before = f.ledger();
    assert_eq!(
        before
            .rounds
            .iter()
            .map(|group| group.sample_size)
            .sum::<u32>(),
        1
    );

    f.core.delete_thread(thread.id, true).unwrap();

    assert_eq!(f.ledger(), before);
    f.core.clear_review_ledger().unwrap();
    let after = f.ledger();
    assert!(after.rounds.is_empty());
}
