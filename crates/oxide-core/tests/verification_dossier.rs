use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    CommandOutcome, Core, DispatchRequest, ItemKind, PermissionMode, SequencedThreadEvent,
    ThreadEvent, ThreadStatus, VerificationCommand, VerificationKind, VerificationState,
};
use oxide_provider::{ActivityCategory, CommandRecord, FakeProvider, ProviderEvent, TurnStatus};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tempfile::TempDir;

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
    scripts: Mutex<HashMap<u32, Sender<Script>>>,
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

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    // Checkpoints are taken in the main checkout, which is also where the fake writes files.
    core.set_project_threads_in_main_checkout(project_id, true)
        .unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
        scripts: Mutex::default(),
    }
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

/// A Thread whose Turn the default fake runs on its own, such as a dispatched one.
fn wait_until_completed(f: &Fixture, thread_id: u32) {
    for _ in 0..6000 {
        let snapshot = f.core.get_thread_snapshot(thread_id).unwrap();
        if snapshot.turn_count > 0 && snapshot.thread.status == ThreadStatus::Completed {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the Thread never completed its Turn");
}

fn run_turn(f: &Fixture, thread_id: u32, script: Script) {
    run_turn_with_prompt(f, thread_id, "go", script);
}

fn run_turn_with_prompt(f: &Fixture, thread_id: u32, prompt: &str, script: Script) {
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, prompt).unwrap();
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

fn agent_message(sender: &Sender<ProviderEvent>, item_index: u32, text: &str) {
    let _ = sender.send(ProviderEvent::ItemStarted {
        item_index,
        kind: ItemKind::AgentMessage,
        parent_item_index: None,
        category: None,
    });
    let _ = sender.send(ProviderEvent::ItemCompleted {
        item_index,
        kind: ItemKind::AgentMessage,
        content: text.to_string(),
        parent_item_index: None,
        category: None,
        command: None,
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
fn the_dossier_shows_the_stored_issue_with_its_title_and_link() {
    let f = fixture();
    let thread = f
        .core
        .dispatch_thread(DispatchRequest {
            project_id: f.project_id,
            prompt: "Fix the parser".into(),
            provider: "fake".into(),
            model: None,
            effort: None,
            permission_mode: None,
            base_branch: Some("main".into()),
            issue_number: Some(51),
            issue_title: Some("Parser crashes on empty input".into()),
            issue_url: Some("https://github.com/example/oxide/issues/51".into()),
        })
        .unwrap();
    wait_until_completed(&f, thread.id);

    let dossier = f.core.verification_dossier(thread.id).unwrap();

    let issue = dossier.intent.issue.expect("the issue is stored");
    assert_eq!(issue.number, 51);
    assert_eq!(
        issue.title.as_deref(),
        Some("Parser crashes on empty input")
    );
    assert_eq!(
        issue.url.as_deref(),
        Some("https://github.com/example/oxide/issues/51")
    );
    assert_eq!(dossier.intent.prompts, vec!["Fix the parser"]);
}

#[test]
fn the_dossier_shows_the_threads_prompts_as_intent() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn_with_prompt(&f, thread_id, "Add the parser", Box::new(|_| {}));
    run_turn_with_prompt(&f, thread_id, "Add tests for it", Box::new(|_| {}));

    let dossier = f.core.verification_dossier(thread_id).unwrap();

    assert_eq!(
        dossier.intent.prompts,
        vec!["Add the parser", "Add tests for it"]
    );
    assert!(dossier.intent.issue.is_none());
}

#[test]
fn the_closing_agent_message_is_a_claim_beside_the_computed_facts() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| {
            command(sender, 0, "cargo test", CommandOutcome::Failed, Some(1));
            agent_message(sender, 1, "All 12 tests pass.");
        }),
    );

    let dossier = f.core.verification_dossier(thread_id).unwrap();

    assert_eq!(
        check(&f, thread_id, "cargo test").state,
        VerificationState::Failed
    );
    let claim = dossier.claim.expect("the closing message is a claim");
    assert_eq!(claim.text, "All 12 tests pass.");
    assert_eq!(claim.turn_index, 0);
}

#[test]
fn an_earlier_turns_message_is_not_the_closing_claim() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| agent_message(sender, 0, "The first answer.")),
    );
    run_turn(
        &f,
        thread_id,
        Box::new(|sender| command(sender, 0, "cargo test", CommandOutcome::Succeeded, Some(0))),
    );

    let dossier = f.core.verification_dossier(thread_id).unwrap();

    assert!(dossier.claim.is_none());
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
