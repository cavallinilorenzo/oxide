use oxide_core::{Core, ItemKind, PermissionMode, ThreadEvent, ThreadStatus, TurnStatus};
use oxide_provider::{FakeProvider, Provider, ProviderEvent};
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
                parent_item_index: None,
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
                parent_item_index: None,
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
                parent_item_index: None,
                item_index: 0,
                kind: oxide_provider::ItemKind::AgentMessage,
            });
            let _ = s.send(ProviderEvent::ItemCompleted {
                parent_item_index: None,
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
            parent_item_index: None,
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
            parent_item_index: None,
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

fn core_with_project() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.path().join("proj").join(".git")).unwrap();
    let id = core.rescan_projects().unwrap()[0].id;
    (dir, core, id)
}

fn wait_turn_completed(rx: &crossbeam_channel::Receiver<oxide_core::SequencedThreadEvent>) {
    while let Ok(e) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if matches!(e.event, ThreadEvent::TurnCompleted { .. }) {
            return;
        }
    }
    panic!("turn never completed");
}

#[test]
fn scripted_fake_provider_turn_has_every_item_kind_with_nested_subagent_children() {
    let (_dir, core, project_id) = core_with_project();
    let thread = core
        .create_thread(
            project_id,
            "fake",
            Some("fake-model".into()),
            Some("high".into()),
            PermissionMode::AutoEdit,
        )
        .unwrap();
    core.register_fake_provider(thread.id, FakeProvider::scripted());
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "do everything").unwrap();
    wait_turn_completed(&rx);

    let snap = core.get_thread_snapshot(thread.id).unwrap();
    let turn = &snap.turns[0];
    let kinds: std::collections::HashSet<_> = turn.items.iter().map(|i| i.kind).collect();
    for k in [
        ItemKind::AgentMessage,
        ItemKind::Reasoning,
        ItemKind::ToolCall,
        ItemKind::FileChange,
        ItemKind::Subagent,
    ] {
        assert!(kinds.contains(&k), "missing {k:?}");
    }
    let subagent = turn
        .items
        .iter()
        .find(|i| i.kind == ItemKind::Subagent)
        .unwrap();
    assert_eq!(subagent.parent_item_index, None);
    assert!(
        turn.items
            .iter()
            .any(|i| i.parent_item_index == Some(subagent.item_index)),
        "subagent has a nested child item"
    );
    // The Turn records the Model and Effort it ran with.
    assert_eq!(turn.model.as_deref(), Some("fake-model"));
    assert_eq!(turn.effort.as_deref(), Some("high"));
}

#[test]
fn reasoning_items_are_dropped_when_provider_lacks_reasoning_text() {
    let (_dir, core, project_id) = core_with_project();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let mut fake = FakeProvider::scripted();
    fake.set_capabilities(oxide_provider::ProviderCapabilities {
        reasoning_text: false,
        ..fake.capabilities()
    });
    core.register_fake_provider(thread.id, fake);
    let (snap0, rx) = core.subscribe_thread(thread.id).unwrap();
    assert!(!snap0.capabilities.reasoning_text);
    core.send_prompt(thread.id, "go").unwrap();

    let mut saw_reasoning_event = false;
    while let Ok(e) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        match e.event {
            ThreadEvent::ItemStarted {
                kind: ItemKind::Reasoning,
                ..
            }
            | ThreadEvent::ItemCompleted {
                kind: ItemKind::Reasoning,
                ..
            } => saw_reasoning_event = true,
            ThreadEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(!saw_reasoning_event);
    let snap = core.get_thread_snapshot(thread.id).unwrap();
    assert!(
        snap.turns[0]
            .items
            .iter()
            .all(|i| i.kind != ItemKind::Reasoning)
    );
    assert!(!snap.turns[0].items.is_empty());
}

#[test]
fn image_attachments_are_stored_under_home_and_referenced_from_the_turn() {
    let (dir, core, project_id) = core_with_project();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, FakeProvider::scripted());
    let (snap0, rx) = core.subscribe_thread(thread.id).unwrap();
    assert!(snap0.capabilities.image_attachments);

    let path = core.save_attachment(b"\x89PNG fake", "png").unwrap();
    assert!(path.starts_with(dir.path().join("attachments")));
    assert_eq!(std::fs::read(&path).unwrap(), b"\x89PNG fake");

    core.send_prompt_with_attachments(thread.id, "look", std::slice::from_ref(&path))
        .unwrap();
    wait_turn_completed(&rx);
    let snap = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(
        snap.turns[0].attachments,
        vec![path.to_string_lossy().to_string()]
    );
}

#[test]
fn attachments_are_rejected_when_provider_lacks_image_attachments() {
    let (_dir, core, project_id) = core_with_project();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    let mut fake = FakeProvider::scripted();
    fake.set_capabilities(oxide_provider::ProviderCapabilities {
        image_attachments: false,
        ..fake.capabilities()
    });
    core.register_fake_provider(thread.id, fake);
    let path = core.save_attachment(b"x", "png").unwrap();
    assert!(
        core.send_prompt_with_attachments(thread.id, "look", &[path])
            .is_err()
    );
}

#[test]
fn save_attachment_rejects_non_image_extensions() {
    let (_dir, core, _) = core_with_project();
    assert!(core.save_attachment(b"x", "../evil").is_err());
    assert!(core.save_attachment(b"x", "sh").is_err());
}

#[test]
fn attachments_outside_the_attachments_folder_are_rejected_even_with_dotdot() {
    let (dir, core, project_id) = core_with_project();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, FakeProvider::scripted());
    let saved = core.save_attachment(b"x", "png").unwrap();
    std::fs::write(dir.path().join("secret.txt"), b"s").unwrap();
    let sneaky = saved.parent().unwrap().join("..").join("secret.txt");
    assert!(
        core.send_prompt_with_attachments(thread.id, "x", &[sneaky.clone()])
            .is_err()
    );
    assert!(core.read_attachment(&sneaky).is_err());
}
