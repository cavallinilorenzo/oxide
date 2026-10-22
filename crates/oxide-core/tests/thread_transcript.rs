use oxide_core::{
    Core, ItemKind, PermissionMode, SequencedThreadEvent, ThreadEvent, ThreadStatus, TurnError,
    TurnStatus,
};
use oxide_provider::{ApprovalKind, FakeProvider, Provider, ProviderEvent};
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

fn open_core_with_project(dir: &std::path::Path) -> (Core, u32) {
    let core = Core::open(dir).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project_id = core.rescan_projects().unwrap()[0].id;
    (core, project_id)
}

/// A Fake whose every prompt starts a Turn (always reporting turn_index 0, as a
/// naive Provider might) and leaves it running for the test to finish.
fn fake_that_starts_turns() -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
    });
    fake
}

/// Waits for `wanted`, returning every event seen up to and including it.
fn wait_for_status(
    rx: &crossbeam_channel::Receiver<SequencedThreadEvent>,
    wanted: ThreadStatus,
) -> Vec<ThreadEvent> {
    let mut seen = Vec::new();
    loop {
        let evt = rx
            .recv_timeout(std::time::Duration::from_secs(3))
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted}; saw {seen:?}"));
        let done = evt.event == ThreadEvent::ThreadStatusChanged { status: wanted };
        seen.push(evt.event);
        if done {
            return seen;
        }
    }
}

#[test]
fn stop_interrupts_the_turn_and_the_next_prompt_reuses_the_session() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let fake = fake_that_starts_turns();
    let sender = fake.sender();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "first").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    core.interrupt_thread(thread.id).unwrap();
    wait_for_status(&rx, ThreadStatus::Interrupted);

    core.send_prompt(thread.id, "second").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    sender
        .send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        })
        .unwrap();
    wait_for_status(&rx, ThreadStatus::Completed);

    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Completed);
    let turns: Vec<_> = snapshot
        .turns
        .iter()
        .map(|t| (t.turn_index, t.prompt.as_str(), t.status))
        .collect();
    assert_eq!(
        turns,
        vec![
            (0, "first", TurnStatus::Interrupted),
            (1, "second", TurnStatus::Completed),
        ]
    );
    assert_eq!(recorder.starts(), 1, "the session must not be restarted");
    assert_eq!(recorder.prompts(), vec!["first", "second"]);
}

#[test]
fn provider_crash_mid_turn_fails_only_that_thread_and_keeps_the_stderr_tail() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());

    let crashing = fake_that_starts_turns();
    let crashing_sender = crashing.sender();
    let crashing_recorder = crashing.recorder();
    let crashing_thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(crashing_thread.id, crashing);

    let healthy = fake_that_starts_turns();
    let healthy_sender = healthy.sender();
    let healthy_thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(healthy_thread.id, healthy);

    let (_, crashing_rx) = core.subscribe_thread(crashing_thread.id).unwrap();
    let (_, healthy_rx) = core.subscribe_thread(healthy_thread.id).unwrap();
    core.send_prompt(crashing_thread.id, "will crash").unwrap();
    core.send_prompt(healthy_thread.id, "keeps going").unwrap();
    wait_for_status(&crashing_rx, ThreadStatus::Working);
    wait_for_status(&healthy_rx, ThreadStatus::Working);

    crashing_sender
        .send(ProviderEvent::Exited {
            code: Some(101),
            stderr_tail: Some("thread 'main' panicked at src/main.rs:1:1".into()),
        })
        .unwrap();
    let seen = wait_for_status(&crashing_rx, ThreadStatus::Error);
    let expected_error = TurnError {
        message: "The Provider exited unexpectedly (exit code 101)".into(),
        stderr_tail: Some("thread 'main' panicked at src/main.rs:1:1".into()),
    };
    assert!(
        seen.contains(&ThreadEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Error,
            error: Some(expected_error.clone()),
        }),
        "the failed Turn is broadcast with its error; saw {seen:?}"
    );

    healthy_sender
        .send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        })
        .unwrap();
    wait_for_status(&healthy_rx, ThreadStatus::Completed);

    let snapshot = core.get_thread_snapshot(crashing_thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Error);
    assert_eq!(snapshot.turns[0].status, TurnStatus::Error);
    assert_eq!(snapshot.turns[0].error, Some(expected_error));
    assert_eq!(
        core.get_thread_snapshot(healthy_thread.id)
            .unwrap()
            .thread
            .status,
        ThreadStatus::Completed
    );

    // A subscribe round trip drains the actor, so any automatic re-send would have happened.
    core.subscribe_thread(crashing_thread.id).unwrap();
    assert_eq!(crashing_recorder.prompts(), vec!["will crash"]);
}

#[test]
fn provider_crash_during_an_approval_fails_the_turn() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let fake = fake_that_starts_turns();
    let sender = fake.sender();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "edit a file").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    sender
        .send(ProviderEvent::ApprovalRequested {
            id: "approval-1".into(),
            kind: ApprovalKind::FileChange,
            summary: "Write src/lib.rs".into(),
            options: vec![],
        })
        .unwrap();
    wait_for_status(&rx, ThreadStatus::NeedsInput);
    sender
        .send(ProviderEvent::Exited {
            code: None,
            stderr_tail: Some("killed by signal 9".into()),
        })
        .unwrap();
    wait_for_status(&rx, ThreadStatus::Error);

    let turn = &core.get_thread_snapshot(thread.id).unwrap().turns[0];
    assert_eq!(turn.status, TurnStatus::Error);
    assert_eq!(
        turn.error,
        Some(TurnError {
            message: "The Provider exited unexpectedly".into(),
            stderr_tail: Some("killed by signal 9".into()),
        })
    );
    core.subscribe_thread(thread.id).unwrap();
    assert_eq!(recorder.prompts(), vec!["edit a file"]);
}

#[test]
fn provider_retry_is_a_notice_and_a_fatal_error_is_kept_on_the_turn() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let fake = fake_that_starts_turns();
    let sender = fake.sender();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();

    core.send_prompt(thread.id, "hello").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    sender
        .send(ProviderEvent::Error {
            message: "Rate limited, retrying in 5s".into(),
            code: Some("rate_limit".into()),
            retrying: true,
        })
        .unwrap();
    let notice = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
    assert_eq!(
        notice.event,
        ThreadEvent::ProviderRetrying {
            message: "Rate limited, retrying in 5s".into()
        }
    );
    assert_eq!(
        core.get_thread_snapshot(thread.id).unwrap().thread.status,
        ThreadStatus::Working
    );

    sender
        .send(ProviderEvent::Error {
            message: "API error: overloaded".into(),
            code: None,
            retrying: false,
        })
        .unwrap();
    sender
        .send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Error,
        })
        .unwrap();
    let seen = wait_for_status(&rx, ThreadStatus::Error);
    let expected_error = TurnError {
        message: "API error: overloaded".into(),
        stderr_tail: None,
    };
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, ThreadEvent::ThreadStatusChanged { .. })
                && *e
                    != ThreadEvent::ThreadStatusChanged {
                        status: ThreadStatus::Error
                    }),
        "the retry never changed status; saw {seen:?}"
    );

    let turn = &core.get_thread_snapshot(thread.id).unwrap().turns[0];
    assert_eq!(turn.status, TurnStatus::Error);
    assert_eq!(turn.error, Some(expected_error));
    core.subscribe_thread(thread.id).unwrap();
    assert_eq!(recorder.prompts(), vec!["hello"]);
}

#[test]
fn provider_exiting_while_idle_is_silent() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let fake = fake_that_starts_turns();
    let sender = fake.sender();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();

    sender
        .send(ProviderEvent::Exited {
            code: Some(0),
            stderr_tail: None,
        })
        .unwrap();
    // Provider events are handled in order, so seeing the marker means Exited was handled.
    sender
        .send(ProviderEvent::Unknown {
            raw: "marker".into(),
        })
        .unwrap();

    let first = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
    assert_eq!(
        first.event,
        ThreadEvent::Unknown,
        "nothing is broadcast for the exit"
    );
    let snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Completed);
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
        supports_reasoning: false,
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
        core.send_prompt_with_attachments(thread.id, "x", std::slice::from_ref(&sneaky))
            .is_err()
    );
    assert!(core.read_attachment(&sneaky).is_err());
}

/// A Thread whose fake Provider answers every prompt with one completed Turn
/// holding one agent message, `"answer to <prompt>"`.
fn thread_with_answering_provider(core: &Core, dir: &std::path::Path) -> oxide_core::ThreadSummary {
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        // Every Turn reports index 0, as the default fake does: positions,
        // not Provider turn indexes, order the Transcript.
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender.send(ProviderEvent::ItemCompleted {
            item_index: 0,
            kind: oxide_provider::ItemKind::AgentMessage,
            content: format!("answer to {prompt}"),
            parent_item_index: None,
        });
        let _ = sender.send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: oxide_provider::TurnStatus::Completed,
        });
    });
    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    thread
}

fn run_turns(core: &Core, thread_id: u32, n: u32) {
    let (_snapshot, rx) = core.subscribe_thread(thread_id).unwrap();
    for i in 0..n {
        core.send_prompt(thread_id, &format!("prompt {i}")).unwrap();
        loop {
            let evt = rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
            if let ThreadEvent::TurnCompleted { .. } = evt.event {
                break;
            }
        }
    }
}

#[test]
fn list_turns_returns_turns_in_pages_by_position() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let thread = thread_with_answering_provider(&core, dir.path());
    run_turns(&core, thread.id, 7);

    let page = core.list_turns(thread.id, 2, 3).unwrap();
    assert_eq!(page.offset, 2);
    assert_eq!(page.turn_count, 7);
    let prompts: Vec<_> = page.turns.iter().map(|t| t.prompt.as_str()).collect();
    assert_eq!(prompts, ["prompt 2", "prompt 3", "prompt 4"]);
    assert_eq!(page.turns[0].items.len(), 1);
    assert_eq!(page.turns[0].items[0].content, "answer to prompt 2");

    // The last page is short; past the end is empty.
    let last = core.list_turns(thread.id, 5, 3).unwrap();
    let prompts: Vec<_> = last.turns.iter().map(|t| t.prompt.as_str()).collect();
    assert_eq!(prompts, ["prompt 5", "prompt 6"]);
    assert!(core.list_turns(thread.id, 7, 3).unwrap().turns.is_empty());
}

#[test]
fn subscribing_opens_on_the_most_recent_turns_only() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let thread = thread_with_answering_provider(&core, dir.path());
    let total = oxide_core::SNAPSHOT_TURNS + 5;
    run_turns(&core, thread.id, total);

    let (snapshot, _rx) = core.subscribe_thread(thread.id).unwrap();
    assert_eq!(snapshot.turn_count, total);
    assert_eq!(snapshot.turn_offset, 5);
    assert_eq!(snapshot.turns.len() as u32, oxide_core::SNAPSHOT_TURNS);
    assert_eq!(snapshot.turns[0].prompt, "prompt 5");
    assert_eq!(
        snapshot.turns.last().unwrap().prompt,
        format!("prompt {}", total - 1)
    );
}
