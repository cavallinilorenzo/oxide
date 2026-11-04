use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    CommandOutcome, Core, ItemKind, PermissionMode, SequencedThreadEvent, ThreadEvent,
    ThreadStatus, VerificationCommand, VerificationKind, VerificationState,
};
use oxide_provider::{
    ActivityCategory, ApprovalDecision, ApprovalKind, CommandRecord, FakeProvider, ProviderEvent,
    TurnStatus,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tempfile::TempDir;

const FAKE_GH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/gh/gh");

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
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// What a Turn does between its Checkpoints: write files and report Items.
type Script = Box<dyn FnOnce(&Sender<ProviderEvent>) + Send>;

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project_id: u32,
    work: PathBuf,
    gh_dir: PathBuf,
    scripts: Mutex<HashMap<u32, Sender<Script>>>,
}

impl Fixture {
    fn install_gh(&self, state: serde_json::Value) {
        let names = if cfg!(windows) {
            vec!["gh", "gh.py", "gh.cmd"]
        } else {
            vec!["gh", "gh.py"]
        };
        for name in names {
            let from = Path::new(FAKE_GH).with_file_name(name);
            std::fs::copy(from, self.gh_dir.join(name)).unwrap();
        }
        std::fs::write(self.gh_dir.join("state.json"), state.to_string()).unwrap();
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let work = root.join("scan").join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    std::fs::write(work.join("b.txt"), "keep\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);

    let gh_dir = root.join("bin");
    std::fs::create_dir_all(&gh_dir).unwrap();

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    // Checkpoints are taken in the main checkout, which is also where the fake writes files.
    core.set_project_threads_in_main_checkout(project_id, true)
        .unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
        gh_dir,
        scripts: Mutex::default(),
    }
}

fn branch(f: &Fixture, name: &str) {
    git(&f.work, &["checkout", "-q", "-b", name]);
}

/// A fake whose Turn starts, waits for a script, then completes. Spawning keeps the actor free
/// to take the start Checkpoint before the script edits the files.
fn scripted_fake(scripts: Receiver<Script>) -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let (sender, scripts) = (sender.clone(), scripts.clone());
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            scripts.recv().unwrap()(&sender);
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    fake
}

fn new_thread(f: &Fixture) -> u32 {
    let id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let (scripts, release) = unbounded();
    f.core.register_fake_provider(id, scripted_fake(release));
    f.scripts.lock().unwrap().insert(id, scripts);
    id
}

fn wait_for(rx: &Receiver<SequencedThreadEvent>, accept: impl Fn(&ThreadEvent) -> bool) {
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("timed out waiting for a thread event");
        if accept(&event.event) {
            return;
        }
    }
}

fn run_turn(f: &Fixture, thread_id: u32, script: Script) {
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, |event| {
        matches!(event, ThreadEvent::TurnStarted { .. })
    });
    f.scripts.lock().unwrap()[&thread_id].send(script).unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, |event| {
        matches!(
            event,
            ThreadEvent::ThreadStatusChanged {
                status: ThreadStatus::Completed
            }
        )
    });
}

fn file_change(sender: &Sender<ProviderEvent>, item_index: u32, path: &str) {
    let _ = sender.send(ProviderEvent::ItemStarted {
        item_index,
        kind: ItemKind::FileChange,
        parent_item_index: None,
        category: None,
    });
    let _ = sender.send(ProviderEvent::ItemCompleted {
        item_index,
        kind: ItemKind::FileChange,
        content: path.to_string(),
        parent_item_index: None,
        category: None,
        command: None,
    });
}

fn command(
    sender: &Sender<ProviderEvent>,
    item_index: u32,
    line: &str,
    outcome: CommandOutcome,
    exit_code: Option<i32>,
) {
    let _ = sender.send(ProviderEvent::ItemStarted {
        item_index,
        kind: ItemKind::ToolCall,
        parent_item_index: None,
        category: Some(ActivityCategory::Run),
    });
    let _ = sender.send(ProviderEvent::ItemCompleted {
        item_index,
        kind: ItemKind::ToolCall,
        content: format!("{line}\nran"),
        parent_item_index: None,
        category: Some(ActivityCategory::Run),
        command: Some(CommandRecord::reported(line, outcome, exit_code)),
    });
}

fn check(f: &Fixture, thread_id: u32, command: &str) -> VerificationCommand {
    f.core
        .verification_dossier(thread_id)
        .unwrap()
        .commands
        .into_iter()
        .find(|check| check.command == command)
        .unwrap_or_else(|| panic!("no {command} in the Dossier"))
}

#[test]
fn a_successful_check_after_the_turns_last_change_is_fresh() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            let file = work.join("a.txt");
            std::fs::write(&file, "one\ntwo\n").unwrap();
            // Claude Code reports an absolute path; the diff names it relative to the checkout.
            file_change(sender, 0, &file.to_string_lossy());
            command(sender, 1, "cargo test", CommandOutcome::Succeeded, Some(0));
        }),
    );

    let check = check(&f, thread_id, "cargo test");
    assert_eq!(check.state, VerificationState::Fresh);
    assert_eq!(check.kind, VerificationKind::Test);
    assert_eq!(check.turn_index, Some(0));
    assert_eq!(check.exit_code, Some(0));
}

#[test]
fn an_agent_edit_after_a_successful_check_makes_it_stale() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
            file_change(sender, 0, "a.txt");
            command(sender, 1, "cargo test", CommandOutcome::Succeeded, Some(0));
            std::fs::write(work.join("a.txt"), "one\nthree\n").unwrap();
            file_change(sender, 2, "a.txt");
        }),
    );

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Stale
    );
}

#[test]
fn a_human_edit_after_the_turn_makes_a_successful_check_stale() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
            file_change(sender, 0, "a.txt");
            command(sender, 1, "cargo test", CommandOutcome::Succeeded, Some(0));
        }),
    );

    std::fs::write(f.work.join("a.txt"), "one\nedited by hand\n").unwrap();

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Stale
    );
}

#[test]
fn another_turn_that_changes_the_tree_makes_an_earlier_check_stale() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
            file_change(sender, 0, "a.txt");
            command(sender, 1, "cargo test", CommandOutcome::Succeeded, Some(0));
        }),
    );
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            std::fs::write(work.join("b.txt"), "keep\nchanged\n").unwrap();
            file_change(sender, 0, "b.txt");
        }),
    );

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Stale
    );
}

#[test]
fn a_failed_check_is_failed() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| {
            command(sender, 0, "cargo test", CommandOutcome::Failed, Some(1));
        }),
    );

    let check = check(&f, thread_id, "cargo test");
    assert_eq!(check.state, VerificationState::Failed);
    assert_eq!(check.outcome, Some(CommandOutcome::Failed));
    assert_eq!(check.exit_code, Some(1));
}

#[test]
fn a_project_command_that_never_ran_is_never_run() {
    let f = fixture();
    let thread_id = new_thread(&f);
    f.core
        .set_project_verification_commands(
            f.project_id,
            &["pnpm run verify".to_string(), "cargo test".to_string()],
        )
        .unwrap();

    let dossier = f.core.verification_dossier(thread_id).unwrap();
    let verify = dossier
        .commands
        .iter()
        .find(|check| check.command == "pnpm run verify")
        .unwrap();
    assert_eq!(verify.state, VerificationState::NeverRun);
    assert_eq!(verify.kind, VerificationKind::Other);
    assert_eq!(verify.turn_index, None);
    // A declared built-in command is never run too, and is classified as a test.
    let test = dossier
        .commands
        .iter()
        .find(|check| check.command == "cargo test")
        .unwrap();
    assert_eq!(test.state, VerificationState::NeverRun);
    assert_eq!(test.kind, VerificationKind::Test);
}

#[test]
fn a_project_command_that_ran_is_matched_to_its_declaration() {
    let f = fixture();
    let thread_id = new_thread(&f);
    f.core
        .set_project_verification_commands(f.project_id, &["pnpm run verify".to_string()])
        .unwrap();
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| {
            command(
                sender,
                0,
                "pnpm run verify -- --strict",
                CommandOutcome::Succeeded,
                Some(0),
            );
        }),
    );

    let dossier = f.core.verification_dossier(thread_id).unwrap();
    let verify = dossier
        .commands
        .iter()
        .find(|check| check.command == "pnpm run verify")
        .unwrap();
    assert_eq!(verify.state, VerificationState::Fresh);
    assert!(
        !dossier
            .commands
            .iter()
            .any(|check| check.state == VerificationState::NeverRun)
    );
}

#[test]
fn an_unattributed_change_in_the_turn_makes_freshness_unknown() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |sender| {
            // A shell edit: the file changes, but no FileChange Item names it.
            std::fs::write(work.join("b.txt"), "keep\nchanged by a shell\n").unwrap();
            command(sender, 0, "cargo test", CommandOutcome::Succeeded, Some(0));
        }),
    );

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Unknown
    );
}

#[test]
fn an_unreported_outcome_is_unknown() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| {
            command(sender, 0, "cargo test", CommandOutcome::Unknown, None);
        }),
    );

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Unknown
    );
}

#[test]
fn branch_scope_flags_commits_no_turn_produced() {
    let f = fixture();
    branch(&f, "feature");
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |_sender| {
            std::fs::write(work.join("a.txt"), "one\nwork\n").unwrap();
            git(&work, &["commit", "-qam", "work by the Thread"]);
        }),
    );

    // A commit that lands between Turns belongs to no Turn.
    std::fs::write(f.work.join("b.txt"), "keep\nnot mine\n").unwrap();
    git(&f.work, &["commit", "-qam", "edit b.txt outside the Turn"]);

    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |_sender| {
            std::fs::write(work.join("a.txt"), "one\nwork again\n").unwrap();
            git(&work, &["commit", "-qam", "more work by the Thread"]);
        }),
    );

    let dossier = f.core.branch_dossier(thread_id).unwrap();
    assert_eq!(dossier.base_branch.as_deref(), Some("main"));
    assert!(dossier.coverage_known);
    let subjects: Vec<&str> = dossier
        .uncovered_commits
        .iter()
        .map(|commit| commit.subject.as_str())
        .collect();
    assert_eq!(subjects, ["edit b.txt outside the Turn"]);
}

#[test]
fn a_turn_stored_before_head_was_recorded_still_covers_its_own_commit() {
    let f = fixture();
    branch(&f, "feature");
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(
        &f,
        thread_id,
        Box::new(move |_sender| {
            std::fs::write(work.join("a.txt"), "one\nwork\n").unwrap();
            git(&work, &["commit", "-qam", "work by the Thread"]);
        }),
    );
    rusqlite::Connection::open(f.core.home().join("oxide.db"))
        .unwrap()
        .execute(
            "UPDATE turns SET head_before = NULL, head_after = NULL WHERE thread_id = ?1",
            [thread_id],
        )
        .unwrap();

    let dossier = f.core.branch_dossier(thread_id).unwrap();
    assert!(
        dossier.uncovered_commits.is_empty(),
        "the legacy Turn's time window covers its commit"
    );
}

#[test]
fn branch_scope_shows_the_pull_requests_checks() {
    let f = fixture();
    branch(&f, "feature");
    let thread_id = new_thread(&f);
    f.install_gh(serde_json::json!({
        "auth": "ok",
        "default_branch": "main",
        "required_checks": ["rust"],
        "prs": { "feature": {
            "number": 9,
            "title": "Feature",
            "url": "https://github.com/fake/repo/pull/9",
            "state": "OPEN",
            "isDraft": false,
            "baseRefName": "main",
            "headRefName": "feature",
            "author": { "login": "me" },
            "statusCheckRollup": [
                { "__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS" },
                { "__typename": "CheckRun", "name": "web", "status": "COMPLETED", "conclusion": "FAILURE" },
                { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS" }
            ]
        } }
    }));

    let dossier = f.core.branch_dossier(thread_id).unwrap();
    assert!(dossier.pull_request_known);
    let pull_request = dossier.pull_request.expect("the branch's pull request");
    assert_eq!(pull_request.number, 9);
    assert_eq!(pull_request.url, "https://github.com/fake/repo/pull/9");
    let checks: Vec<(&str, oxide_core::CheckState)> = pull_request
        .checks
        .iter()
        .map(|check| (check.name.as_str(), check.state))
        .collect();
    assert_eq!(
        checks,
        [
            ("rust", oxide_core::CheckState::Success),
            ("web", oxide_core::CheckState::Failure),
            ("lint", oxide_core::CheckState::Pending),
        ]
    );
    assert!(
        pull_request.checks[0].required,
        "branch protection requires rust"
    );
    assert!(!pull_request.checks[1].required);
}

#[test]
fn supervision_counts_approvals_and_permission_modes_with_unrecorded_older_turns() {
    let f = fixture();
    let thread_id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let prompts = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let approval_sender = sender.clone();
    fake.on_prompt({
        let sender = sender.clone();
        let prompts = std::sync::Arc::clone(&prompts);
        move |prompt| {
            let sender = sender.clone();
            let prompts = std::sync::Arc::clone(&prompts);
            let prompt = prompt.to_string();
            std::thread::spawn(move || {
                let _ = sender.send(ProviderEvent::TurnStarted {
                    turn_index: 0,
                    prompt,
                });
                let index = prompts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = sender.send(ProviderEvent::ApprovalRequested {
                    id: format!("approval-{index}"),
                    kind: ApprovalKind::Command,
                    summary: "Run a command".into(),
                    options: vec![],
                });
            });
        }
    });
    fake.on_approval(move |_id, _decision| {
        let sender = approval_sender.clone();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    f.core.register_fake_provider(thread_id, fake);
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();

    f.core.send_prompt(thread_id, "allow").unwrap();
    wait_for(&rx, |event| {
        matches!(
            event,
            ThreadEvent::ApprovalRequested { id, .. } if id == "approval-0"
        )
    });
    f.core
        .respond_to_approval(thread_id, "approval-0", ApprovalDecision::Allow)
        .unwrap();
    wait_for(&rx, |event| {
        matches!(
            event,
            ThreadEvent::ThreadStatusChanged {
                status: ThreadStatus::Completed
            }
        )
    });

    f.core
        .set_thread_permission_mode(thread_id, PermissionMode::AutoEdit)
        .unwrap();
    f.core.send_prompt(thread_id, "deny").unwrap();
    wait_for(&rx, |event| {
        matches!(
            event,
            ThreadEvent::ApprovalRequested { id, .. } if id == "approval-1"
        )
    });
    f.core
        .respond_to_approval(thread_id, "approval-1", ApprovalDecision::Deny)
        .unwrap();
    wait_for(&rx, |event| {
        matches!(
            event,
            ThreadEvent::ThreadStatusChanged {
                status: ThreadStatus::Completed
            }
        )
    });

    let dossier = f.core.verification_dossier(thread_id).unwrap();
    assert_eq!(dossier.supervision.approvals_granted, 1);
    assert_eq!(dossier.supervision.approvals_denied, 1);
    assert_eq!(
        dossier.supervision.permission_modes,
        [
            oxide_core::PermissionModeUse {
                mode: Some(PermissionMode::Ask),
                turns: 1,
            },
            oxide_core::PermissionModeUse {
                mode: Some(PermissionMode::AutoEdit),
                turns: 1,
            },
        ]
    );

    // A Turn stored before permission modes were recorded reads as unknown.
    rusqlite::Connection::open(f.core.home().join("oxide.db"))
        .unwrap()
        .execute(
            "UPDATE turns SET permission_mode = NULL WHERE thread_id = ?1 AND turn_index = 0",
            [thread_id],
        )
        .unwrap();
    let dossier = f.core.verification_dossier(thread_id).unwrap();
    assert_eq!(
        dossier.supervision.permission_modes,
        [
            oxide_core::PermissionModeUse {
                mode: Some(PermissionMode::AutoEdit),
                turns: 1,
            },
            oxide_core::PermissionModeUse {
                mode: None,
                turns: 1,
            },
        ]
    );
}

#[test]
fn built_in_patterns_recognize_common_commands_across_ecosystems() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| {
            for (index, line) in [
                "cargo test",
                "cargo clippy",
                "cargo check",
                "npm test -- --watch=false",
                "pnpm run lint",
                "npx tsc --noEmit",
                "python3 -m pytest -q",
                "golangci-lint run",
                "cd web && npm run test",
                "echo not a check",
            ]
            .into_iter()
            .enumerate()
            {
                command(
                    sender,
                    index as u32,
                    line,
                    CommandOutcome::Succeeded,
                    Some(0),
                );
            }
        }),
    );

    let dossier = f.core.verification_dossier(thread_id).unwrap();
    let find = |command: &str| {
        dossier
            .commands
            .iter()
            .find(|entry| entry.command == command)
            .unwrap_or_else(|| panic!("no {command} in the Dossier"))
    };
    for (command, kind) in [
        ("cargo test", VerificationKind::Test),
        ("cargo clippy", VerificationKind::Lint),
        ("cargo check", VerificationKind::TypeCheck),
        ("npm test", VerificationKind::Test),
        ("pnpm run lint", VerificationKind::Lint),
        ("tsc", VerificationKind::TypeCheck),
        ("pytest", VerificationKind::Test),
        ("golangci-lint", VerificationKind::Lint),
        ("npm run test", VerificationKind::Test),
    ] {
        assert_eq!(find(command).kind, kind, "{command}");
        assert_eq!(find(command).state, VerificationState::Fresh, "{command}");
    }
    assert!(
        !dossier
            .commands
            .iter()
            .any(|entry| entry.command.contains("echo"))
    );
}
