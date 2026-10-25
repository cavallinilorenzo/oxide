use oxide_core::{Core, ItemKind, PermissionMode, ThreadEvent, ThreadStatus, TurnStatus};
use oxide_provider::{ApprovalDecision, ApprovalKind, FakeProvider, ProviderEvent};
use tempfile::tempdir;

#[test]
fn core_runs_approval_end_to_end_and_persists_in_transcript() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project = core.add_project(&project_dir.to_string_lossy()).unwrap();

    let fake = FakeProvider::default();
    let sender = fake.sender();
    let sender_for_approval = sender.clone();

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

    fake.on_approval(move |id, decision| {
        let s = sender_for_approval.clone();
        assert_eq!(id, "appr-1");
        assert_eq!(decision, ApprovalDecision::Allow);
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                parent_item_index: None,
            });
            let _ = s.send(ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                content: "Executed command with approval".into(),
                parent_item_index: None,
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    // 1. Send prompt
    core.send_prompt(thread.id, "Please run tests").unwrap();

    // 2. Wait for ApprovalRequested event
    let mut approval_received = false;
    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::ApprovalRequested {
            id,
            summary,
            kind,
            options,
        } = seq_evt.event
        {
            assert_eq!(id, "appr-1");
            assert_eq!(summary, "Run `cargo test`");
            assert_eq!(kind, ApprovalKind::Command);
            assert_eq!(options, vec!["allow-once"]);
            approval_received = true;
            break;
        }
    }
    assert!(approval_received, "ApprovalRequested not received");

    // Check thread status in snapshot is NeedsInput
    let current_snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(current_snapshot.thread.status, ThreadStatus::NeedsInput);

    // 3. Respond to approval with Allow
    core.respond_to_approval(thread.id, "appr-1", ApprovalDecision::Allow)
        .expect("respond_to_approval failed");

    // 4. Turn should continue to completion
    let mut completed = false;
    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { status, .. } = seq_evt.event {
            assert_eq!(status, TurnStatus::Completed);
            completed = true;
            break;
        }
    }
    assert!(completed, "Turn did not complete after approval");

    // 5. Verify snapshot after completion
    let reloaded = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(reloaded.thread.status, ThreadStatus::Completed);
    assert_eq!(reloaded.turns.len(), 1);
    let turn = &reloaded.turns[0];
    assert_eq!(turn.approvals.len(), 1);
    let app = &turn.approvals[0];
    assert_eq!(app.approval_id, "appr-1");
    assert_eq!(app.kind, ApprovalKind::Command);
    assert_eq!(app.summary, "Run `cargo test`");
    assert_eq!(app.decision, Some(ApprovalDecision::Allow));
    assert!(app.decided_at.is_some());
}

#[test]
fn unanswered_approval_waits_indefinitely_and_resolves_when_interrupted() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project = core.add_project(&project_dir.to_string_lossy()).unwrap();

    let fake = FakeProvider::default();
    let sender = fake.sender();

    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ApprovalRequested {
                id: "appr-wait".into(),
                kind: ApprovalKind::FileChange,
                summary: "Modify src/lib.rs".into(),
                options: vec![],
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "Refactor code").unwrap();

    // Consume until ApprovalRequested
    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::ApprovalRequested { .. } = seq_evt.event {
            break;
        }
    }

    // Injected time: simulate 100 ticks without user answering
    for _ in 0..100 {
        core.tick_thread(thread.id);
    }

    // Must still be NeedsInput! No timeout!
    let snapshot_after_ticks = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot_after_ticks.thread.status, ThreadStatus::NeedsInput);
    assert_eq!(snapshot_after_ticks.turns[0].approvals.len(), 1);
    assert_eq!(snapshot_after_ticks.turns[0].approvals[0].decision, None);

    // Now interrupt the thread
    core.interrupt_thread(thread.id).unwrap();
    // The Provider ends the Turn; wait for it.
    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { .. } = seq_evt.event {
            break;
        }
    }

    // Must be resolved and status Interrupted
    let snapshot_after_interrupt = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(
        snapshot_after_interrupt.thread.status,
        ThreadStatus::Interrupted
    );
    let app = &snapshot_after_interrupt.turns[0].approvals[0];
    assert_eq!(app.decision, Some(ApprovalDecision::Deny));
    assert!(app.decided_at.is_some());
}

#[test]
fn thread_permission_mode_defaults_and_updates_between_turns() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let mut settings = core.settings().settings;
    settings.providers.claude.permission_mode = PermissionMode::FullAccess;
    core.save_settings(&settings).unwrap();

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project = core.add_project(&project_dir.to_string_lossy()).unwrap();

    // Create thread for claude with None mode -> defaults from settings (FullAccess)
    let thread = core
        .create_thread(project.id, "claude", None, None, PermissionMode::FullAccess)
        .unwrap();
    core.register_fake_provider(thread.id, FakeProvider::default());
    assert_eq!(thread.permission_mode, PermissionMode::FullAccess);

    // Update permission mode between turns
    core.set_thread_permission_mode(thread.id, PermissionMode::AutoEdit)
        .unwrap();

    let reloaded = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(reloaded.thread.permission_mode, PermissionMode::AutoEdit);
}

#[test]
fn core_runs_approval_deny_end_to_end() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project = core.add_project(&project_dir.to_string_lossy()).unwrap();

    let fake = FakeProvider::default();
    let sender = fake.sender();
    let sender_for_approval = sender.clone();

    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ApprovalRequested {
                id: "appr-deny-1".into(),
                kind: ApprovalKind::Command,
                summary: "Dangerous command".into(),
                options: vec![],
            });
        });
    });

    fake.on_approval(move |id, decision| {
        let s = sender_for_approval.clone();
        assert_eq!(id, "appr-deny-1");
        assert_eq!(decision, ApprovalDecision::Deny);
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                parent_item_index: None,
            });
            let _ = s.send(ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: ItemKind::AgentMessage,
                content: "Action was denied".into(),
                parent_item_index: None,
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "Try dangerous").unwrap();

    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if matches!(seq_evt.event, ThreadEvent::ApprovalRequested { ref id, .. } if id == "appr-deny-1")
        {
            break;
        }
    }

    core.respond_to_approval(thread.id, "appr-deny-1", ApprovalDecision::Deny)
        .expect("respond_to_approval failed");

    let mut completed = false;
    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { status, .. } = seq_evt.event {
            assert_eq!(status, TurnStatus::Completed);
            completed = true;
            break;
        }
    }
    assert!(completed);

    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.turns[0].approvals.len(), 1);
    assert_eq!(
        snapshot.turns[0].approvals[0].decision,
        Some(ApprovalDecision::Deny)
    );
    assert!(snapshot.turns[0].approvals[0].decided_at.is_some());
}

#[test]
fn unanswered_approval_resolves_when_turn_completes() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project = core.add_project(&project_dir.to_string_lossy()).unwrap();

    let fake = FakeProvider::default();
    let sender = fake.sender();

    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ApprovalRequested {
                id: "appr-turn-end".into(),
                kind: ApprovalKind::Tool,
                summary: "Tool call".into(),
                options: vec![],
            });
            // Complete turn without waiting for approval
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "Prompt").unwrap();

    while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { .. } = seq_evt.event {
            break;
        }
    }

    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.turns[0].approvals.len(), 1);
    assert_eq!(
        snapshot.turns[0].approvals[0].decision,
        Some(ApprovalDecision::Deny)
    );
    assert!(snapshot.turns[0].approvals[0].decided_at.is_some());
}
