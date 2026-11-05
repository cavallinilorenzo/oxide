use oxide_core::blind_review::BlindReviewRequest;
use oxide_core::{Core, Error, PermissionMode};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
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
