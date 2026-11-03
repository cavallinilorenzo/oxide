use crate::{
    Attachment, AttachmentKind, CommandOutcome, ItemKind, PromptSegment, Provider, ProviderEvent,
    StartContext, TurnStatus,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// Numbers each run's scratch folder: the contract tests share a process and run in parallel.
static RUNS: AtomicUsize = AtomicUsize::new(0);

pub fn verify_provider_contract<P: Provider, F: FnOnce() -> P>(factory: F) {
    let mut provider = factory();

    // 1. Capabilities
    let caps = provider.capabilities();
    assert!(
        !caps.supported_permission_modes.is_empty(),
        "provider must offer at least one permission mode"
    );

    // 2. Detect
    let detection = provider.detect().expect("detect must succeed");
    assert!(
        detection.available,
        "provider must be detected as available"
    );

    // 3. Slash command catalog: empty is fine, but every entry must be well formed.
    let catalog = provider
        .slash_commands(std::path::Path::new("."))
        .expect("slash_commands must succeed");
    let mut names = std::collections::HashSet::new();
    for command in &catalog {
        assert!(
            !command.name.is_empty() && !command.name.starts_with('/'),
            "command names are bare words: {:?}",
            command.name
        );
        assert!(names.insert(&command.name), "duplicate {:?}", command.name);
    }

    // 4. Start
    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: caps.supported_permission_modes[0],
    };
    let receiver = provider.start(&context).expect("start must succeed");

    // 5. Send prompt & receive normalized events
    provider
        .send_prompt("Hello test")
        .expect("send_prompt must succeed");

    let mut session_info_seen = false;
    let mut turn_started_seen = false;
    let mut item_started_seen = false;
    let mut item_deltas_seen = false;
    let mut item_completed_seen = false;
    let mut unknown_seen = false;
    let mut turn_completed_seen = false;

    let timeout = Duration::from_secs(5);
    while let Ok(event) = receiver.recv_timeout(timeout) {
        match event {
            ProviderEvent::SessionInfo { session_id } => {
                assert!(!session_id.is_empty());
                session_info_seen = true;
            }
            ProviderEvent::TurnStarted { turn_index, prompt } => {
                assert_eq!(turn_index, 0);
                assert_eq!(prompt, "Hello test");
                turn_started_seen = true;
            }
            ProviderEvent::ItemStarted {
                item_index, kind, ..
            } => {
                assert_eq!(item_index, 0);
                assert_eq!(kind, ItemKind::AgentMessage);
                item_started_seen = true;
            }
            ProviderEvent::ItemDelta { item_index, delta } => {
                assert_eq!(item_index, 0);
                assert!(!delta.is_empty());
                item_deltas_seen = true;
            }
            ProviderEvent::ItemCompleted {
                item_index,
                kind,
                content,
                ..
            } => {
                assert_eq!(item_index, 0);
                assert_eq!(kind, ItemKind::AgentMessage);
                assert_eq!(content, "Hello world!");
                item_completed_seen = true;
            }
            ProviderEvent::Unknown { raw } => {
                assert!(raw.contains("custom_unrecognized_event"));
                unknown_seen = true;
            }
            ProviderEvent::TurnCompleted { turn_index, status } => {
                assert_eq!(turn_index, 0);
                assert_eq!(status, TurnStatus::Completed);
                turn_completed_seen = true;
                break;
            }
            _ => {}
        }
    }

    assert!(session_info_seen, "session info must be emitted");
    assert!(turn_started_seen, "turn started must be emitted");
    assert!(item_started_seen, "item started must be emitted");
    assert!(item_deltas_seen, "item deltas must be emitted");
    assert!(item_completed_seen, "item completed must be emitted");
    assert!(unknown_seen, "unknown events must be passed through");
    assert!(turn_completed_seen, "turn completed must be emitted");

    // 5b. Model and Permission mode changes
    provider.set_model("opus").expect("set_model must succeed");
    provider
        .set_permission_mode(caps.supported_permission_modes[0])
        .expect("set_permission_mode must succeed");

    // 6. A prompt with an Attachment: the Turn names it in place, however it was delivered.
    let folder = std::env::temp_dir().join(format!(
        "oxide-contract-{}-{}",
        std::process::id(),
        RUNS.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&folder).expect("temp dir");
    let path = folder.join("note.txt");
    std::fs::write(&path, "hello").expect("write attachment");
    provider
        .send_prompt_with_segments(&[
            PromptSegment::text("Look at "),
            PromptSegment::Attachment(Attachment {
                id: "contract".into(),
                name: "note.txt".into(),
                kind: AttachmentKind::Text,
                media_type: "text/plain".into(),
                size_bytes: 5,
                path,
            }),
        ])
        .expect("send_prompt_with_segments must succeed");
    let mut attachment_turn_seen = false;
    while let Ok(event) = receiver.recv_timeout(Duration::from_secs(if attachment_turn_seen {
        1
    } else {
        5
    })) {
        match event {
            ProviderEvent::TurnStarted { prompt, .. } => {
                assert_eq!(prompt, "Look at [note.txt]");
                attachment_turn_seen = true;
            }
            ProviderEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    let _ = std::fs::remove_dir_all(&folder);
    assert!(
        attachment_turn_seen,
        "a prompt with an Attachment must start a Turn that names it"
    );

    // 6. Commands: each Provider reports a succeeded, a failed and an unknown command, and the
    // outcome comes from what it reported, never from what the command printed.
    provider
        .send_prompt("commands_contract")
        .expect("send_prompt must succeed");
    let mut commands: Vec<(String, CommandOutcome, Option<i32>)> = Vec::new();
    let mut commands_turn_seen = false;
    while let Ok(event) = receiver.recv_timeout(Duration::from_secs(5)) {
        match event {
            ProviderEvent::TurnStarted { .. } => commands_turn_seen = true,
            ProviderEvent::ItemCompleted {
                command: Some(command),
                ..
            } => {
                let line = command
                    .line
                    .expect("a reported command must carry its command line");
                commands.push((line, command.outcome, command.exit_code));
            }
            ProviderEvent::TurnCompleted { .. } => break,
            _ => {}
        }
    }
    assert!(commands_turn_seen, "the command prompt must start a Turn");
    let outcome_of = |line: &str| {
        commands
            .iter()
            .filter(|(reported, _, _)| reported == line)
            .map(|(_, outcome, _)| *outcome)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        outcome_of("contract-succeeds"),
        vec![CommandOutcome::Succeeded],
        "a command the Provider reports as completed must be succeeded, whatever it printed"
    );
    assert_eq!(
        outcome_of("contract-fails"),
        vec![CommandOutcome::Failed],
        "a command the Provider reports as failed must be failed, whatever it printed"
    );
    assert_eq!(
        outcome_of("contract-unknown"),
        vec![CommandOutcome::Unknown],
        "a Provider that reports no outcome must read as unknown"
    );
    for (line, outcome, exit_code) in &commands {
        match (outcome, exit_code) {
            (CommandOutcome::Succeeded, Some(code)) => assert_eq!(
                *code, 0,
                "{line} succeeded, so a reported exit code is zero"
            ),
            (CommandOutcome::Failed, Some(code)) => assert_ne!(
                *code, 0,
                "{line} failed, so a reported exit code is not zero"
            ),
            _ => {}
        }
    }

    // 7. Shutdown
    provider.shutdown().expect("shutdown must succeed");
    assert!(
        receiver.recv().is_err(),
        "channel must be dropped/disconnected after shutdown"
    );
}
