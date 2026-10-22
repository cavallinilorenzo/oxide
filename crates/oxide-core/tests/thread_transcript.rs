use oxide_core::{Core, ItemKind, PermissionMode, ThreadEvent, ThreadStatus, TurnStatus};
use oxide_provider::{FakeProvider, ProviderEvent};
use tempfile::tempdir;

#[test]
fn creates_thread_and_lists_it() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let projects = core.rescan_projects().unwrap();
    assert_eq!(projects.len(), 1);
    let project = &projects[0];

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .expect("create_thread failed");

    assert_eq!(thread.project_id, project.id);
    assert_eq!(thread.provider, "fake");
    assert_eq!(thread.status, ThreadStatus::Completed);

    let list = core.list_threads(project.id).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, thread.id);
}

#[test]
fn scenario_prompt_streams_events_and_persists_turn_and_items() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let projects = core.rescan_projects().unwrap();
    let project = &projects[0];

    // Create a fake provider with scripted events
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::SessionInfo {
                session_id: "fake-sess-1".into(),
            });
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: oxide_provider::ItemKind::AgentMessage,
            });
            let _ = s.send(ProviderEvent::ItemDelta {
                item_index: 0,
                delta: "Hello ".into(),
            });
            let _ = s.send(ProviderEvent::ItemDelta {
                item_index: 0,
                delta: "world!".into(),
            });
            let _ = s.send(ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: oxide_provider::ItemKind::AgentMessage,
                content: "Hello world!".into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: oxide_provider::TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .expect("create_thread failed");

    // Register our fake provider instance for this thread
    core.register_fake_provider(thread.id, fake);

    // Subscribe before sending prompt
    let (snapshot, event_rx) = core.subscribe_thread(thread.id).expect("subscribe failed");
    assert_eq!(snapshot.turns.len(), 0);

    // Send prompt
    core.send_prompt(thread.id, "Hi agent")
        .expect("send_prompt failed");

    // Receive events
    let mut received_deltas = String::new();
    let mut completed_seen = false;

    while let Ok(seq_event) = event_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        match seq_event.event {
            ThreadEvent::ItemDeltaBatch { delta, .. } => {
                received_deltas.push_str(&delta);
            }
            ThreadEvent::ItemCompleted { content, .. } => {
                assert_eq!(content, "Hello world!");
            }
            ThreadEvent::TurnCompleted { status, .. } => {
                assert_eq!(status, TurnStatus::Completed);
                completed_seen = true;
                break;
            }
            _ => {}
        }
    }

    assert!(completed_seen, "turn completed was not received");
    assert_eq!(received_deltas, "Hello world!");

    // Verify persistence in SQLite after completion
    let reloaded_snapshot = core
        .get_thread_snapshot(thread.id)
        .expect("snapshot failed");
    assert_eq!(reloaded_snapshot.turns.len(), 1);
    let turn = &reloaded_snapshot.turns[0];
    assert_eq!(turn.prompt, "Hi agent");
    assert_eq!(turn.status, TurnStatus::Completed);
    assert_eq!(turn.items.len(), 1);
    assert_eq!(turn.items[0].kind, ItemKind::AgentMessage);
    assert_eq!(turn.items[0].content, "Hello world!");
}

#[test]
fn resubscribing_after_simulated_gap_returns_consistent_snapshot() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let projects = core.rescan_projects().unwrap();
    let project = &projects[0];

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
            let _ = s.send(ProviderEvent::ItemStarted {
                item_index: 0,
                kind: oxide_provider::ItemKind::AgentMessage,
            });
            let _ = s.send(ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: oxide_provider::ItemKind::AgentMessage,
                content: "First answer".into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: oxide_provider::TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    // Initial subscriber connects, drives turn, then disconnects (simulating gap)
    {
        let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
        core.send_prompt(thread.id, "Turn 1").unwrap();
        while let Ok(seq_evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
            if let ThreadEvent::TurnCompleted { .. } = seq_evt.event {
                break;
            }
        }
        // rx drops here
    }

    // New subscriber reconnects after gap
    let (reconnected_snapshot, _new_rx) = core.subscribe_thread(thread.id).unwrap();
    assert_eq!(reconnected_snapshot.thread.status, ThreadStatus::Completed);
    assert_eq!(reconnected_snapshot.turns.len(), 1);
    assert_eq!(reconnected_snapshot.turns[0].prompt, "Turn 1");
    assert_eq!(reconnected_snapshot.turns[0].items.len(), 1);
    assert_eq!(
        reconnected_snapshot.turns[0].items[0].content,
        "First answer"
    );
}

#[test]
fn delta_batching_tested_with_injected_time_never_sleeps() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let projects = core.rescan_projects().unwrap();
    let project = &projects[0];

    let fake = FakeProvider::default();
    let sender = fake.sender();

    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .expect("create_thread failed");
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    // Start turn
    core.send_prompt(thread.id, "Prompt for batching").unwrap();
    // Consume TurnStarted & StatusChanged
    let mut started = false;
    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
        if let ThreadEvent::TurnStarted { .. } = evt.event {
            started = true;
            break;
        }
    }
    assert!(started);

    // Send item started
    sender
        .send(ProviderEvent::ItemStarted {
            item_index: 0,
            kind: oxide_provider::ItemKind::AgentMessage,
        })
        .unwrap();

    // Wait until ItemStarted arrives in rx
    loop {
        let evt = rx
            .recv_timeout(std::time::Duration::from_millis(500))
            .unwrap();
        if let ThreadEvent::ItemStarted { .. } = evt.event {
            break;
        }
    }

    // Now send deltas "foo" and "bar"
    sender
        .send(ProviderEvent::ItemDelta {
            item_index: 0,
            delta: "foo".into(),
        })
        .unwrap();
    sender
        .send(ProviderEvent::ItemDelta {
            item_index: 0,
            delta: "bar".into(),
        })
        .unwrap();

    // Give actor message queue a chance to process ProviderMsg
    // Verify no batch event has arrived yet (because tick has not occurred)
    // To ensure the actor processed the delta messages without sleeping, send a no-op prompt or tick barrier:
    // When tick is called:
    core.tick_thread(thread.id);

    // Now ItemDeltaBatch MUST arrive with "foobar" coalesced
    let batch_evt = rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .unwrap();
    match batch_evt.event {
        ThreadEvent::ItemDeltaBatch { item_index, delta } => {
            assert_eq!(item_index, 0);
            assert_eq!(delta, "foobar");
        }
        other => panic!("expected ItemDeltaBatch, got {:?}", other),
    }

    // Send another delta "baz"
    sender
        .send(ProviderEvent::ItemDelta {
            item_index: 0,
            delta: "baz".into(),
        })
        .unwrap();

    // Tick again to flush "baz"
    core.tick_thread(thread.id);

    let batch_evt2 = rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .unwrap();
    match batch_evt2.event {
        ThreadEvent::ItemDeltaBatch { item_index, delta } => {
            assert_eq!(item_index, 0);
            assert_eq!(delta, "baz");
        }
        other => panic!("expected ItemDeltaBatch, got {:?}", other),
    }

    // Complete item and turn
    sender
        .send(ProviderEvent::ItemCompleted {
            item_index: 0,
            kind: oxide_provider::ItemKind::AgentMessage,
            content: "foobarbaz".into(),
        })
        .unwrap();
    sender
        .send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: oxide_provider::TurnStatus::Completed,
        })
        .unwrap();

    let mut turn_completed = false;
    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
        if let ThreadEvent::TurnCompleted { .. } = evt.event {
            turn_completed = true;
            break;
        }
    }
    assert!(turn_completed);
}
