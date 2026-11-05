use oxide_core::blind_review::BlindReviewRequest;
use oxide_core::{Core, Error, FindingDecision, PermissionMode, ThreadStatus};
use oxide_provider::{FakeProvider, ItemKind, ProviderEvent, TurnStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Fixture {
    _tmp: tempfile::TempDir,
    core: Core,
    work: PathBuf,
    project_id: u32,
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git failed");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.name", "Oxide Test"]);
    git(&work, &["config", "user.email", "test@oxide.local"]);
    git(&work, &["config", "commit.gpgsign", "false"]);
    std::fs::write(work.join("hello.rs"), "fn hello() {}\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "initial commit"]);

    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();

    Fixture {
        _tmp: tmp,
        core,
        work,
        project_id: project.id,
    }
}

fn first_turn(core: &Core, thread_id: u32) -> oxide_core::TurnSnapshot {
    for _ in 0..1000 {
        if let Some(turn) = core.get_thread_snapshot(thread_id).unwrap().turns.first() {
            return turn.clone();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the Thread never started a Turn");
}

fn wait_completed(core: &Core, thread_id: u32) {
    for _ in 0..1000 {
        if core.get_thread_snapshot(thread_id).unwrap().thread.status != ThreadStatus::Working {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the Thread never finished its Turn");
}

struct Reviewed {
    fixture: Fixture,
    original: u32,
    review: u32,
    prompts: Arc<Mutex<Vec<String>>>,
}

/// An original Thread with a one-line change, and a Blind review of it whose Provider replies with
/// `reply` as its closing message.
fn reviewed(reply: &str) -> Reviewed {
    let fixture = fixture();
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let original = fixture
        .core
        .create_thread(fixture.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let seen = prompts.clone();
    fake.on_prompt(move |prompt| {
        seen.lock().unwrap().push(prompt.to_string());
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender.send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        });
    });
    fixture.core.register_fake_provider(original.id, fake);
    fixture.core.send_prompt(original.id, "implement").unwrap();
    let _ = first_turn(&fixture.core, original.id);

    let checkout = PathBuf::from(
        fixture
            .core
            .checkout_path(fixture.project_id, Some(original.id))
            .unwrap(),
    );
    std::fs::write(
        checkout.join("hello.rs"),
        "fn hello() { println!(\"world\"); }\n",
    )
    .unwrap();

    let (review, prompt) = fixture
        .core
        .create_blind_review_thread(BlindReviewRequest {
            project_id: fixture.project_id,
            thread_id: Some(original.id),
            provider: "fake".into(),
            model: None,
            effort: None,
            scope: "uncommitted".into(),
            turn_index: None,
            issue: Some("Add a greeting".into()),
        })
        .unwrap();

    let review_fake = FakeProvider::default();
    let sender = review_fake.sender();
    let reply = reply.to_string();
    review_fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender.send(ProviderEvent::ItemStarted {
            item_index: 0,
            kind: ItemKind::AgentMessage,
            parent_item_index: None,
            category: None,
        });
        let _ = sender.send(ProviderEvent::ItemCompleted {
            item_index: 0,
            kind: ItemKind::AgentMessage,
            content: reply.clone(),
            parent_item_index: None,
            category: None,
            command: None,
        });
        let _ = sender.send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        });
    });
    fixture.core.register_fake_provider(review.id, review_fake);
    fixture.core.send_prompt(review.id, &prompt).unwrap();
    let _ = first_turn(&fixture.core, review.id);
    wait_completed(&fixture.core, review.id);

    Reviewed {
        fixture,
        original: original.id,
        review: review.id,
        prompts,
    }
}

#[test]
fn findings_are_parsed_from_the_closing_message_and_anchored_to_the_reviewed_diff() {
    let r = reviewed(
        r#"```json
        [
          {"path": "hello.rs", "line": 1, "body": "Why print here?"}
        ]
        ```"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 1, "one finding was parsed");
    let finding = &findings[0];
    assert_eq!(finding.provider, "fake");
    assert_eq!(finding.review_thread_id, r.review);
    assert_eq!(finding.path.as_deref(), Some("hello.rs"));
    assert_eq!(finding.line, Some(1));
    assert_eq!(finding.side, Some(oxide_core::CommentSide::New));
    assert!(finding.code.contains("println!"));
    assert_eq!(finding.body, "Why print here?");
    assert!(!finding.plain);
    assert_eq!(finding.decision, FindingDecision::Pending);

    // The review Thread shows the same findings.
    let from_review = r.fixture.core.list_blind_review_findings(r.review).unwrap();
    assert_eq!(from_review.len(), 1);
    assert_eq!(from_review[0].id, finding.id);
}

#[test]
fn a_reply_that_cannot_be_parsed_is_kept_as_plain_text_never_dropped() {
    let r = reviewed("I could not format this as JSON. Line 1 looks odd.");
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 1);
    assert!(findings[0].plain);
    assert_eq!(findings[0].decision, FindingDecision::Pending);
    assert!(
        findings[0].body.contains("I could not format this as JSON"),
        "the reply must be kept: {:?}",
        findings[0].body
    );
}

#[test]
fn a_finding_that_cannot_be_anchored_is_kept_as_plain_text_beside_the_anchored_ones() {
    let r = reviewed(
        r#"[
          {"path": "hello.rs", "line": 99, "body": "A line that is not in the diff"},
          {"path": "hello.rs", "line": 1, "body": "An anchored finding"}
        ]"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 2, "both findings are kept");
    assert!(findings[0].plain);
    assert_eq!(findings[0].path.as_deref(), Some("hello.rs"));
    assert_eq!(findings[0].line, Some(99));
    assert!(!findings[1].plain);
    assert_eq!(findings[1].body, "An anchored finding");
}

#[test]
fn keeping_a_finding_makes_a_draft_and_dismissing_one_never_reaches_the_thread() {
    let r = reviewed(
        r#"[
          {"path": "hello.rs", "line": 1, "body": "Keep this finding"},
          {"path": "hello.rs", "line": 1, "body": "Dismiss this finding"}
        ]"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    assert_eq!(findings.len(), 2);

    let kept = r
        .fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap()
        .expect("an anchored finding becomes a draft");
    assert_eq!(kept.provider.as_deref(), Some("fake"));
    assert_eq!(kept.body, "Keep this finding");

    r.fixture
        .core
        .dismiss_blind_review_finding(findings[1].id)
        .unwrap();

    let drafts = r.fixture.core.list_line_comments(r.original).unwrap();
    assert_eq!(drafts.len(), 1, "only the kept finding is a draft");
    assert_eq!(drafts[0].body, "Keep this finding");

    // Keeping twice does not duplicate the draft.
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();
    assert_eq!(
        r.fixture.core.list_line_comments(r.original).unwrap().len(),
        1
    );

    // The existing send flow delivers only what was kept.
    r.fixture.core.send_line_comments(r.original).unwrap();
    r.fixture.core.tick_thread(r.original);
    let prompts = r.prompts.lock().unwrap();
    let sent = prompts.last().expect("the Thread received a prompt");
    assert!(sent.contains("Keep this finding"));
    assert!(!sent.contains("Dismiss this finding"));
}

#[test]
fn deleting_a_review_thread_keeps_the_draft_it_put_on_the_reviewed_thread() {
    let r = reviewed(r#"[{"path": "hello.rs", "line": 1, "body": "Keep me"}]"#);
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();

    r.fixture.core.delete_thread(r.review, true).unwrap();

    let drafts = r.fixture.core.list_line_comments(r.original).unwrap();
    assert_eq!(drafts.len(), 1, "the kept draft outlives the review Thread");
    assert_eq!(drafts[0].body, "Keep me");
    assert_eq!(drafts[0].provider.as_deref(), Some("fake"));
}

#[test]
fn deleting_the_reviewed_thread_with_a_kept_finding_leaves_nothing_behind() {
    let r = reviewed(r#"[{"path": "hello.rs", "line": 1, "body": "Keep me"}]"#);
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();

    r.fixture.core.delete_thread(r.original, true).unwrap();

    assert!(
        r.fixture
            .core
            .list_blind_review_findings(r.review)
            .unwrap()
            .is_empty(),
        "the findings die with the Thread they were about"
    );
}

#[test]
fn the_dossier_names_the_reviewer_and_counts_the_kept_findings() {
    let r = reviewed(
        r#"[
          {"path": "hello.rs", "line": 1, "body": "Kept"},
          {"path": "hello.rs", "line": 1, "body": "Dismissed"}
        ]"#,
    );
    let findings = r
        .fixture
        .core
        .list_blind_review_findings(r.original)
        .unwrap();
    r.fixture
        .core
        .keep_blind_review_finding(findings[0].id)
        .unwrap();
    r.fixture
        .core
        .dismiss_blind_review_finding(findings[1].id)
        .unwrap();

    let dossier = r.fixture.core.verification_dossier(r.original).unwrap();
    assert_eq!(dossier.blind_reviews.len(), 1);
    let summary = &dossier.blind_reviews[0];
    assert_eq!(summary.provider, "fake");
    assert_eq!(summary.review_thread_id, r.review);
    assert_eq!(summary.findings, 2);
    assert_eq!(summary.kept, 1);
}

#[test]
fn agy_cannot_honour_non_writing_and_is_not_offered_for_blind_review() {
    let f = fixture();
    assert!(!f.core.provider_can_honour_non_writing("agy"));
    assert!(!f.core.provider_can_honour_non_writing("antigravity"));
    assert!(f.core.provider_can_honour_non_writing("fake"));
    assert!(f.core.provider_can_honour_non_writing("claude"));
    assert!(f.core.provider_can_honour_non_writing("codex"));

    let options = f.core.blind_review_providers(None);
    assert!(
        !options
            .iter()
            .any(|o| o.provider == "agy" || o.provider == "antigravity")
    );

    let req = BlindReviewRequest {
        project_id: f.project_id,
        thread_id: None,
        provider: "agy".into(),
        model: None,
        effort: None,
        scope: "uncommitted".into(),
        turn_index: None,
        issue: None,
    };
    let err = f.core.start_blind_review(req).unwrap_err();
    match err {
        Error::Provider(msg) => {
            assert!(msg.contains("cannot honour a non-writing configuration"));
        }
        other => panic!("unexpected error: {:?}", other),
    }
}

#[test]
fn single_provider_allowed_and_clearly_labelled_as_same_provider() {
    let f = fixture();
    let options = f.core.blind_review_providers(Some("fake"));
    let fake_opt = options
        .iter()
        .find(|o| o.provider == "fake")
        .expect("fake provider present");
    assert!(fake_opt.same_provider);
    assert!(fake_opt.label.contains("same provider"));
}

#[test]
fn blind_review_runs_in_detached_worktree_with_isolated_checkout() {
    let f = fixture();
    // Make a change in the working directory
    std::fs::write(
        f.work.join("hello.rs"),
        "fn hello() { println!(\"world\"); }\n",
    )
    .unwrap();

    let req = BlindReviewRequest {
        project_id: f.project_id,
        thread_id: None,
        provider: "fake".into(),
        model: None,
        effort: None,
        scope: "uncommitted".into(),
        turn_index: None,
        issue: Some("Fix issue #42: add greeting".into()),
    };

    let thread = f.core.start_blind_review(req).unwrap();
    assert!(
        thread.blind_review,
        "Thread must be identifiable as a blind review"
    );
    assert_eq!(thread.permission_mode, PermissionMode::Ask);
    assert!(
        thread
            .title
            .as_deref()
            .unwrap_or("")
            .starts_with("Blind review")
    );

    let worktree_path = PathBuf::from(
        thread
            .worktree_path
            .expect("detached worktree path must be set"),
    );
    assert!(worktree_path.exists(), "worktree folder must exist");
    assert_ne!(
        worktree_path, f.work,
        "worktree must not be the main checkout"
    );

    // Assert checkout isolation: worktree is detached
    let current_branch = git(&worktree_path, &["branch", "--show-current"]);
    assert!(
        current_branch.is_empty(),
        "detached worktree must not be on any branch, got '{current_branch}'"
    );
    let status_output = git(&worktree_path, &["status"]);
    assert!(
        status_output.contains("Not currently on any branch")
            || status_output.contains("HEAD detached")
            || status_output.contains("detached at"),
        "worktree must be in detached HEAD state, got: {status_output}"
    );

    // Changes in main checkout do not affect detached worktree
    std::fs::write(f.work.join("isolation_main.txt"), "from main").unwrap();
    assert!(!worktree_path.join("isolation_main.txt").exists());

    // Changes in detached worktree do not affect main checkout
    std::fs::write(
        worktree_path.join("isolation_worktree.txt"),
        "from worktree",
    )
    .unwrap();
    assert!(!f.work.join("isolation_worktree.txt").exists());

    // Deleting the Thread removes its detached worktree
    let outcome = f.core.delete_thread(thread.id, true).unwrap();
    assert_eq!(outcome, oxide_core::DeleteOutcome::Deleted);
    assert!(
        !worktree_path.exists(),
        "detached worktree must be removed on thread deletion"
    );
}

#[test]
fn blind_review_prompt_contains_only_diff_issue_and_required_format_delimited() {
    let f = fixture();
    // Start an initial chat thread that made changes
    let original_thread = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    // Simulate some transcript on original thread
    f.core
        .send_prompt(
            original_thread.id,
            "Please implement feature X with secret reasoning",
        )
        .unwrap();
    let _ = first_turn(&f.core, original_thread.id);

    // Make an edit in original thread's checkout
    let original_checkout = PathBuf::from(
        f.core
            .checkout_path(f.project_id, Some(original_thread.id))
            .unwrap(),
    );
    std::fs::write(
        original_checkout.join("feature.rs"),
        "pub fn feature_x() -> i32 { 42 }\n",
    )
    .unwrap();

    let recorded_prompts = Arc::new(Mutex::new(Vec::new()));
    let (seen, sender_slot) = (recorded_prompts.clone(), Arc::new(Mutex::new(None)));
    let fake = FakeProvider::default();
    let sender = fake.sender();
    *sender_slot.lock().unwrap() = Some(sender.clone());

    let (seen_clone, sender_clone) = (seen.clone(), sender.clone());
    fake.on_prompt(move |prompt| {
        seen_clone.lock().unwrap().push(prompt.to_string());
        let _ = sender_clone.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender_clone.send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        });
    });

    let (thread_summary, prompt) = f
        .core
        .create_blind_review_thread(BlindReviewRequest {
            project_id: f.project_id,
            thread_id: Some(original_thread.id),
            provider: "fake".into(),
            model: None,
            effort: None,
            scope: "uncommitted".into(),
            turn_index: None,
            issue: Some("Issue #100: Add Feature X\nDetailed requirements...".into()),
        })
        .unwrap();

    f.core.register_fake_provider(thread_summary.id, fake);
    f.core.send_prompt(thread_summary.id, &prompt).unwrap();

    let _ = first_turn(&f.core, thread_summary.id);
    let captured = seen
        .lock()
        .unwrap()
        .first()
        .cloned()
        .expect("a prompt was received");

    // Prompt assertions:
    // 1. Contains issue delimited as data
    assert!(captured.contains("<issue>"));
    assert!(captured.contains("</issue>"));
    assert!(captured.contains("Issue #100: Add Feature X"));

    // 2. Contains diff delimited as data
    assert!(captured.contains("<diff>"));
    assert!(captured.contains("</diff>"));
    assert!(captured.contains("pub fn feature_x()"));

    // 3. Contains required output format
    assert!(captured.contains("```json"));
    assert!(captured.contains("\"path\":"));
    assert!(captured.contains("\"line\":"));
    assert!(captured.contains("\"body\":"));

    // 4. Contains NO transcript content from original thread
    assert!(
        !captured.contains("secret reasoning"),
        "transcript content must not leak into blind review prompt"
    );
}
