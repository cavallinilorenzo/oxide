//! Rule suggestions: feedback a user keeps giving, turned into a proposed `AGENTS.md` rule.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use oxide_core::{
    CommentScope, CommentSide, Core, NewLineComment, RuleSuggestion, ThreadSummary, TurnStatus,
};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: u32,
    work: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("scan").join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "x\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap().id;
    Fixture {
        _tmp: tmp,
        core,
        project,
        work,
    }
}

impl Fixture {
    fn thread(&self) -> ThreadSummary {
        self.core
            .create_thread(self.project, "fake", None, None, None)
            .unwrap()
    }

    fn comment(&self, thread_id: u32, body: &str) {
        self.core
            .add_line_comment(
                thread_id,
                NewLineComment {
                    scope: CommentScope::Uncommitted,
                    path: "a.txt".into(),
                    side: CommentSide::New,
                    line: 1,
                    code: "x".into(),
                    body: body.into(),
                },
            )
            .unwrap();
    }

    /// Sends one comment on a Thread of its own, so feedback spans Threads, then waits for the
    /// Turn to finish so the next send is not refused.
    fn send_in_new_thread(&self, body: &str) -> ThreadSummary {
        let thread = self.thread();
        self.comment(thread.id, body);
        self.core.send_line_comments(thread.id).unwrap();
        wait_until(|| self.turn_finished(thread.id));
        thread
    }

    fn turn_finished(&self, thread_id: u32) -> bool {
        self.core
            .get_thread_snapshot(thread_id)
            .map(|snapshot| {
                snapshot
                    .turns
                    .last()
                    .is_some_and(|turn| turn.status == TurnStatus::Completed)
            })
            .unwrap_or(false)
    }

    fn suggestions(&self) -> Vec<RuleSuggestion> {
        self.core.rule_suggestions(self.project).unwrap()
    }

    fn status(&self) -> String {
        git(&self.work, &["status", "--porcelain"])
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Three comments that mean the same thing in slightly different words.
const RECURRING: [&str; 3] = [
    "Please validate the input before using it",
    "Always validate the input before using it",
    "Please validate the input before using it",
];

/// A near miss: five of seven words shared, just under the threshold.
const NEAR_MISS: &str = "Please validate the output before merging it";

#[test]
fn three_similar_comments_across_threads_make_one_suggestion() {
    let f = fixture();
    for body in RECURRING {
        f.send_in_new_thread(body);
    }

    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].project_id, f.project);
    assert_eq!(suggestions[0].comments, RECURRING);
}

#[test]
fn two_similar_comments_are_not_enough() {
    let f = fixture();
    for body in RECURRING[..2].iter() {
        f.send_in_new_thread(body);
    }
    assert!(f.suggestions().is_empty());
}

#[test]
fn short_feedback_can_become_a_suggestion_too() {
    let f = fixture();
    for _ in 0..3 {
        f.send_in_new_thread("Add tests");
    }
    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].comments, vec!["Add tests".to_string(); 3]);
}

#[test]
fn three_similar_comments_in_one_thread_are_not_a_pattern_across_threads() {
    let f = fixture();
    let thread = f.thread();
    for body in RECURRING {
        f.comment(thread.id, body);
    }
    f.core.send_line_comments(thread.id).unwrap();
    wait_until(|| f.turn_finished(thread.id));
    assert!(f.suggestions().is_empty());

    // One more Thread saying the same thing makes it feedback the user keeps giving.
    f.send_in_new_thread(RECURRING[0]);
    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].comments.len(), 4);
}

#[test]
fn a_near_match_below_the_threshold_is_not_recurring_feedback() {
    let f = fixture();
    for body in [RECURRING[0], RECURRING[1], NEAR_MISS] {
        f.send_in_new_thread(body);
    }
    assert!(f.suggestions().is_empty());

    // The fourth comment matches the first two, so the cluster reaches three without the miss.
    f.send_in_new_thread(RECURRING[2]);
    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert!(!suggestions[0].comments.iter().any(|c| c == NEAR_MISS));
    assert_eq!(suggestions[0].comments.len(), 3);
}

#[test]
fn unsent_drafts_are_not_feedback_yet() {
    let f = fixture();
    let thread = f.thread();
    for body in RECURRING {
        f.comment(thread.id, body);
    }

    assert!(f.suggestions().is_empty());
}

#[test]
fn a_suggestion_can_be_dismissed_for_good() {
    let f = fixture();
    for body in RECURRING {
        f.send_in_new_thread(body);
    }
    let suggestion = f.suggestions().remove(0);

    f.core
        .dismiss_rule_suggestion(f.project, suggestion.id)
        .unwrap();
    assert!(f.suggestions().is_empty());

    // More of the same feedback does not bring it back.
    f.send_in_new_thread(RECURRING[0]);
    f.send_in_new_thread(RECURRING[1]);
    assert!(f.suggestions().is_empty());
}

#[test]
fn accepting_starts_a_thread_that_proposes_the_rule_without_writing_anything() {
    let f = fixture();
    for body in RECURRING {
        f.send_in_new_thread(body);
    }
    let suggestion = f.suggestions().remove(0);
    assert!(
        !f.work.join("AGENTS.md").exists(),
        "accepting must not write instructions itself"
    );
    let before = f.status();

    let thread = f
        .core
        .accept_rule_suggestion(f.project, suggestion.id, "fake")
        .unwrap();

    assert_eq!(thread.project_id, f.project);
    wait_until(|| f.turn_finished(thread.id));
    let snapshot = f.core.get_thread_snapshot(thread.id).unwrap();
    let prompt = &snapshot.turns[0].prompt;
    assert!(prompt.contains("AGENTS.md"), "{prompt}");
    for body in RECURRING {
        assert!(
            prompt.contains(body),
            "the proposal must show its basis: {prompt}"
        );
    }
    // The proposal runs in the Thread's own worktree, like any other chat Thread, so nothing
    // reaches the shared checkout before the user reviews it.
    let listed = f.core.list_threads(f.project).unwrap();
    let thread = listed.iter().find(|t| t.id == thread.id).unwrap();
    let worktree = PathBuf::from(
        thread
            .worktree_path
            .as_ref()
            .expect("a worktree of its own"),
    );
    assert!(
        !worktree.starts_with(&f.work),
        "{worktree:?} is not the main checkout"
    );
    assert!(!worktree.join("AGENTS.md").exists());
    // Nothing was written or committed outside the Thread's own review flow.
    assert_eq!(f.status(), before);
    assert!(!f.work.join("AGENTS.md").exists());
    assert!(f.suggestions().is_empty(), "an accepted suggestion is done");
}

#[test]
fn feedback_that_returns_after_accepting_is_suggested_again() {
    let f = fixture();
    for body in RECURRING {
        f.send_in_new_thread(body);
    }
    let suggestion = f.suggestions().remove(0);
    f.core
        .accept_rule_suggestion(f.project, suggestion.id, "fake")
        .unwrap();
    assert!(f.suggestions().is_empty());

    for body in RECURRING {
        f.send_in_new_thread(body);
    }
    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].comments, RECURRING);
}

#[test]
fn recurring_feedback_survives_deleting_a_thread() {
    let f = fixture();
    let first = f.send_in_new_thread(RECURRING[0]);
    f.send_in_new_thread(RECURRING[1]);
    f.send_in_new_thread(RECURRING[2]);

    f.core.delete_thread(first.id, true).unwrap();

    let suggestions = f.suggestions();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].comments.len(), 3);
}

#[test]
fn the_review_ledger_still_holds_no_comment_text() {
    let f = fixture();
    let secret = "Please validate the secret input before using it";
    f.send_in_new_thread(secret);
    f.send_in_new_thread("Always validate the secret input before using it");
    f.send_in_new_thread("Please validate the secret input before using it");

    assert_eq!(f.suggestions().len(), 1);
    let ledger = serde_json::to_string(&f.core.review_ledger(f.project).unwrap()).unwrap();
    assert!(!ledger.contains("secret input"), "{ledger}");
}

#[test]
fn clearing_the_ledger_also_forgets_the_comments_kept_for_suggestions() {
    let f = fixture();
    for body in RECURRING {
        f.send_in_new_thread(body);
    }
    assert_eq!(f.suggestions().len(), 1);

    f.core.clear_review_ledger().unwrap();
    assert!(f.suggestions().is_empty());
}
