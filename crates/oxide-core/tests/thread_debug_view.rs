use oxide_core::{Core, PermissionMode, ThreadEvent};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use tempfile::tempdir;

fn setup() -> (tempfile::TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);

    let project_dir = dir.path().join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    let project_id = core.add_project(&project_dir.to_string_lossy()).unwrap().id;

    (dir, core, project_id)
}

// ── Slice 1: Unknown events are persisted ────────────────────────────────────

#[test]
fn unknown_events_are_persisted_in_transcript() {
    let (_dir, core, project_id) = setup();

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
            let _ = s.send(ProviderEvent::Unknown {
                raw: r#"{"type":"mystery","data":42}"#.into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "go").unwrap();

    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        if let ThreadEvent::TurnCompleted { .. } = evt.event {
            break;
        }
    }

    let regular_snapshot = core.get_thread_snapshot(thread.id).unwrap();
    assert!(regular_snapshot.turns[0].unknown_events.is_empty());
    let (snapshot, _debug_rx) = core.subscribe_thread_debug(thread.id).unwrap();
    assert_eq!(snapshot.turns.len(), 1);
    let turn = &snapshot.turns[0];
    assert_eq!(
        turn.unknown_events.len(),
        1,
        "one unknown event should be persisted"
    );
    assert_eq!(
        turn.unknown_events[0].raw,
        r#"{"type":"mystery","data":42}"#
    );
}

// ── Slice 2: No raw payloads cross IPC without a debug subscriber ─────────────

#[test]
fn regular_subscriber_receives_no_raw_payload() {
    let (_dir, core, project_id) = setup();

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
            let _ = s.send(ProviderEvent::ItemDelta {
                item_index: 0,
                delta: "hello".into(),
            });
            let _ = s.send(ProviderEvent::Unknown {
                raw: r#"{"secret":"payload"}"#.into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "go").unwrap();

    let mut saw_unknown = false;
    while let Ok(evt) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
        match &evt.event {
            ThreadEvent::Unknown => {
                saw_unknown = true;
            }
            ThreadEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(
        saw_unknown,
        "Unknown event should still arrive on regular channel"
    );
}

// ── Slice 3: Debug subscriber streams raw payloads paired with each event ─────

#[test]
fn debug_subscriber_receives_raw_payloads_paired_with_normalized_events() {
    let (_dir, core, project_id) = setup();

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
            let _ = s.send(ProviderEvent::ItemDelta {
                item_index: 0,
                delta: "hello".into(),
            });
            let _ = s.send(ProviderEvent::Unknown {
                raw: r#"{"type":"mystery"}"#.into(),
            });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });

    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);

    let (_snapshot, debug_rx) = core.subscribe_thread_debug(thread.id).unwrap();
    core.send_prompt(thread.id, "go").unwrap();

    let mut found_unknown_with_raw = false;
    let mut found_turn_completed_with_raw = false;
    let mut found_delta_batch_with_raw = false;

    while let Ok(debug_evt) = debug_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        match &debug_evt.event {
            ThreadEvent::Unknown => {
                // Debug event: raw_payload should be present and match
                assert!(
                    debug_evt.raw_payload.is_some(),
                    "debug event for Unknown should carry raw_payload"
                );
                assert_eq!(
                    debug_evt.raw_payload.as_deref(),
                    Some(r#"{"type":"mystery"}"#)
                );
                found_unknown_with_raw = true;
            }
            ThreadEvent::TurnCompleted { .. } => {
                // Known events also carry a raw_payload (the serialized ProviderEvent)
                assert!(
                    debug_evt.raw_payload.is_some(),
                    "debug event for TurnCompleted should carry raw_payload"
                );
                found_turn_completed_with_raw = true;
                break;
            }
            ThreadEvent::ItemDeltaBatch { .. } => {
                let raw_payload = debug_evt.raw_payload.as_deref().unwrap();
                let raw_events: Vec<serde_json::Value> = serde_json::from_str(raw_payload).unwrap();
                assert_eq!(raw_events.len(), 1);
                assert!(raw_events[0].to_string().contains("hello"));
                found_delta_batch_with_raw = true;
            }
            _ => {}
        }
    }

    assert!(
        found_unknown_with_raw,
        "debug subscriber should see Unknown with raw_payload"
    );
    assert!(
        found_delta_batch_with_raw,
        "debug subscriber should see ItemDeltaBatch with raw payloads"
    );
    assert!(
        found_turn_completed_with_raw,
        "debug subscriber should see TurnCompleted with raw_payload"
    );
}
