use std::time::Duration;

use oxide_core::thread::ThreadStatus;
use oxide_core::{BoardEvent, Core, PermissionMode, TurnStatus};
use oxide_provider::{ApprovalDecision, ApprovalKind, FakeProvider, ProviderEvent};
use tempfile::tempdir;

fn core_with_project() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.path().join("my-project/.git")).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
    (dir, core, project.id)
}

fn next(rx: &crossbeam_channel::Receiver<BoardEvent>) -> BoardEvent {
    rx.recv_timeout(Duration::from_secs(5))
        .expect("board event")
}

#[test]
fn snapshot_lists_the_projects_threads_and_events_follow_status_changes() {
    let (_dir, core, project) = core_with_project();
    let first = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();

    let (snapshot, rx) = core.subscribe_board(project).unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].thread.id, first.id);
    assert_eq!(snapshot[0].thread.status, ThreadStatus::Completed);

    let second = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let BoardEvent::ThreadChanged(card) = next(&rx);
    assert_eq!(card.thread.id, second.id);

    core.send_prompt(second.id, "hello").unwrap();
    let mut statuses = vec![];
    while let Ok(BoardEvent::ThreadChanged(card)) = rx.recv_timeout(Duration::from_secs(5)) {
        assert_eq!(card.thread.id, second.id);
        if statuses.is_empty() && card.thread.status != ThreadStatus::Working {
            continue; // the prompt un-archives the Thread first: no change yet
        }
        statuses.push(card.thread.status);
        if card.thread.status == ThreadStatus::Completed {
            break;
        }
    }
    assert_eq!(statuses.first(), Some(&ThreadStatus::Working));
    assert_eq!(statuses.last(), Some(&ThreadStatus::Completed));
}

#[test]
fn archiving_emits_an_event_and_other_projects_are_not_heard() {
    let (_dir, core, project) = core_with_project();
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let (_, rx) = core.subscribe_board(project).unwrap();
    let (_, other_rx) = core.subscribe_board(project + 100).unwrap();

    core.set_thread_archived(thread.id, true).unwrap();

    let BoardEvent::ThreadChanged(card) = next(&rx);
    assert!(card.thread.archived);
    assert!(other_rx.try_recv().is_err());
}

#[test]
fn pending_approvals_are_on_the_card_and_answering_clears_them() {
    let (_dir, core, project) = core_with_project();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let on_approval = sender.clone();
    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ApprovalRequested {
                id: "appr-1".into(),
                kind: ApprovalKind::Command,
                summary: "Run `cargo test`".into(),
                options: vec!["allow-once".into()],
            });
        });
    });
    fake.on_approval(move |_, _| {
        let s = on_approval.clone();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_board(project).unwrap();

    core.send_prompt(thread.id, "please").unwrap();
    let card = loop {
        let BoardEvent::ThreadChanged(card) = next(&rx);
        if card.thread.status == ThreadStatus::NeedsInput {
            break card;
        }
    };
    assert_eq!(card.pending_approvals.len(), 1);
    assert_eq!(card.pending_approvals[0].summary, "Run `cargo test`");

    core.respond_to_approval(thread.id, "appr-1", ApprovalDecision::Allow)
        .unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx);
        if card.thread.status == ThreadStatus::Completed {
            assert!(card.pending_approvals.is_empty());
            break;
        }
    }
}

#[test]
fn renaming_and_stopping_a_thread_reach_the_board() {
    let (_dir, core, project) = core_with_project();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
    });
    let thread = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_board(project).unwrap();

    core.rename_thread(thread.id, "Fix login").unwrap();
    let BoardEvent::ThreadChanged(card) = next(&rx);
    assert_eq!(card.thread.title.as_deref(), Some("Fix login"));

    core.send_prompt(thread.id, "go").unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx);
        if card.thread.status == ThreadStatus::Working {
            break;
        }
    }
    core.interrupt_thread(thread.id).unwrap();
    loop {
        let BoardEvent::ThreadChanged(card) = next(&rx);
        if card.thread.status == ThreadStatus::Interrupted {
            break;
        }
    }
}
