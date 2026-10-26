use crossbeam_channel::Receiver;
use oxide_provider::agy::AgyProvider;
use oxide_provider::contract_suite::verify_provider_contract;
use oxide_provider::{ItemKind, PermissionMode, Provider, ProviderEvent, StartContext, TurnStatus};
use std::path::PathBuf;
use std::time::Duration;

mod support;

fn fake_agy() -> support::FakeCli {
    support::fake_cli("agy")
}

fn context(mode: PermissionMode) -> StartContext {
    StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: mode,
    }
}

/// Everything up to and including the next `TurnCompleted`.
fn collect_turn(rx: &Receiver<ProviderEvent>) -> Vec<ProviderEvent> {
    let mut events = Vec::new();
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(10)) {
        let done = matches!(event, ProviderEvent::TurnCompleted { .. });
        events.push(event);
        if done {
            return events;
        }
    }
    panic!("turn did not complete; got {events:?}");
}

fn wire_argv(log: &std::path::Path) -> Vec<(u64, Vec<String>)> {
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .filter(|v| v["type"] == "argv")
        .map(|v| {
            (
                v["pid"].as_u64().unwrap(),
                v["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_string())
                    .collect(),
            )
        })
        .collect()
}

fn provider_with_log() -> (AgyProvider, tempfile::NamedTempFile, support::FakeCli) {
    let log = tempfile::NamedTempFile::new().unwrap();
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    provider.set_env("OXIDE_WIRE_LOG", log.path().to_str().unwrap());
    (provider, log, fake)
}

#[test]
fn agy_provider_passes_shared_contract_suite() {
    let fake = fake_agy();
    verify_provider_contract(|| AgyProvider::with_command(fake.command()));
}

#[test]
fn agy_offers_only_the_modes_it_can_honour_and_no_attachments() {
    let caps = AgyProvider::new().capabilities();
    assert_eq!(
        caps.supported_permission_modes,
        vec![PermissionMode::AutoEdit, PermissionMode::FullAccess]
    );
    assert!(!caps.interactive_approvals);
    assert!(!caps.image_attachments);
}

#[test]
fn agy_refuses_ask_mode() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    assert!(provider.start(&context(PermissionMode::Ask)).is_err());
    provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    assert!(provider.set_permission_mode(PermissionMode::Ask).is_err());
    provider.shutdown().unwrap();
}

#[test]
fn second_turn_spawns_a_new_process_resuming_the_same_conversation() {
    let (mut provider, log, _fake) = provider_with_log();
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();

    provider.send_prompt("first").unwrap();
    let first = collect_turn(&rx);
    provider.send_prompt("second").unwrap();
    let second = collect_turn(&rx);

    assert!(matches!(
        first[0],
        ProviderEvent::SessionInfo { .. } | ProviderEvent::TurnStarted { turn_index: 0, .. }
    ));
    assert!(second.iter().any(|e| matches!(
        e,
        ProviderEvent::TurnStarted { turn_index: 1, prompt } if prompt == "second"
    )));

    let runs = wire_argv(log.path());
    assert_eq!(runs.len(), 2);
    assert_ne!(runs[0].0, runs[1].0, "each Turn is its own process");
    assert!(!runs[0].1.contains(&"--conversation".to_string()));
    let at = runs[1]
        .1
        .iter()
        .position(|a| a == "--conversation")
        .unwrap();
    assert_eq!(runs[1].1[at + 1], "411a104c-944f-4695-82b0-44454b6edad2");
    provider.shutdown().unwrap();
}

#[test]
fn resume_continues_the_given_conversation_from_the_first_turn() {
    let (mut provider, log, _fake) = provider_with_log();
    let rx = provider
        .resume("conv-42", &context(PermissionMode::AutoEdit))
        .unwrap();
    provider.send_prompt("hi").unwrap();
    collect_turn(&rx);
    let runs = wire_argv(log.path());
    let at = runs[0]
        .1
        .iter()
        .position(|a| a == "--conversation")
        .unwrap();
    assert_eq!(runs[0].1[at + 1], "conv-42");
    provider.shutdown().unwrap();
}

#[test]
fn permission_mode_model_and_effort_map_to_flags_on_every_turn() {
    let (mut provider, log, _fake) = provider_with_log();
    let mut ctx = context(PermissionMode::AutoEdit);
    ctx.model = Some("gemini-3.8-flash-high".into());
    ctx.effort = Some("low".into());
    let rx = provider.start(&ctx).unwrap();

    provider.send_prompt("one").unwrap();
    collect_turn(&rx);
    provider
        .set_permission_mode(PermissionMode::FullAccess)
        .unwrap();
    provider.set_model("claude-sonnet-4-6").unwrap();
    provider.send_prompt("two").unwrap();
    collect_turn(&rx);

    let runs = wire_argv(log.path());
    let first = &runs[0].1;
    let second = &runs[1].1;
    assert!(!first.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(
        first
            .windows(2)
            .any(|w| w == ["--model", "gemini-3.8-flash-high"])
    );
    assert!(first.windows(2).any(|w| w == ["--effort", "low"]));
    assert!(
        first
            .windows(2)
            .any(|w| w == ["--output-format", "stream-json"])
    );
    assert!(first.windows(2).any(|w| w == ["-p", "one"]));
    assert!(second.contains(&"--dangerously-skip-permissions".to_string()));
    assert!(
        second
            .windows(2)
            .any(|w| w == ["--model", "claude-sonnet-4-6"])
    );
    provider.shutdown().unwrap();
}

#[test]
fn steps_map_to_items() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    provider.send_prompt("tools_test").unwrap();
    let events = collect_turn(&rx);

    let completed: Vec<(u32, ItemKind, String)> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::ItemCompleted {
                item_index,
                kind,
                content,
                ..
            } => Some((*item_index, *kind, content.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        completed,
        vec![
            (
                0,
                ItemKind::ToolCall,
                "view_file /work/src/main.rs\nfn main() {}".into()
            ),
            (1, ItemKind::FileChange, "/work/src/main.rs".into()),
            (
                2,
                ItemKind::ToolCall,
                "run_command rm -rf x\nPERMISSION_DENIED: Soft-denied: approval required".into()
            ),
            (3, ItemKind::AgentMessage, "Hello world!".into()),
        ]
    );
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::ItemStarted {
            item_index: 0,
            kind: ItemKind::ToolCall,
            ..
        }
    )));
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ApprovalRequested { .. }))
    );
    provider.shutdown().unwrap();
}

#[test]
fn prompt_arguments_preserve_quotes_and_shell_characters() {
    let (mut provider, log, _fake) = provider_with_log();
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    let prompt = "Explain \"a & b\" | <input> ^ !literal! %PATH%";
    provider.send_prompt(prompt).unwrap();
    collect_turn(&rx);
    let runs = wire_argv(log.path());
    assert!(runs[0].1.windows(2).any(|args| args == ["-p", prompt]));
    provider.shutdown().unwrap();
}

#[test]
fn error_result_emits_error_then_failed_turn() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    provider.send_prompt("error_test").unwrap();
    let events = collect_turn(&rx);
    assert!(events.iter().any(|e| matches!(
        e,
        ProviderEvent::Error { message, retrying: false, .. } if message.contains("quota")
    )));
    assert!(matches!(
        events.last(),
        Some(ProviderEvent::TurnCompleted {
            status: TurnStatus::Error,
            ..
        })
    ));
    provider.shutdown().unwrap();
}

#[test]
fn interrupt_ends_the_turn_as_interrupted() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    provider.send_prompt("interrupt_test").unwrap();
    // Let the fake install its SIGINT handler and emit init.
    loop {
        if matches!(
            rx.recv_timeout(Duration::from_secs(10)).unwrap(),
            ProviderEvent::SessionInfo { .. }
        ) {
            break;
        }
    }
    provider.interrupt().unwrap();
    let events = collect_turn(&rx);
    assert!(matches!(
        events.last(),
        Some(ProviderEvent::TurnCompleted {
            status: TurnStatus::Interrupted,
            ..
        })
    ));
    provider.shutdown().unwrap();
}

#[test]
fn process_dying_without_a_result_reports_exit_with_stderr() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    let rx = provider.start(&context(PermissionMode::AutoEdit)).unwrap();
    provider.send_prompt("crash_test").unwrap();
    let exited = loop {
        match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
            ProviderEvent::Exited { code, stderr_tail } => break (code, stderr_tail),
            ProviderEvent::TurnCompleted { .. } => panic!("no result was sent"),
            _ => {}
        }
    };
    assert_eq!(exited.0, Some(7));
    assert!(exited.1.unwrap().contains("something broke"));
}

#[test]
fn model_catalog_comes_from_agy_models() {
    let fake = fake_agy();
    let provider = AgyProvider::with_command(fake.command());
    let models = provider.list_models().unwrap();
    let slugs: Vec<&str> = models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(
        slugs,
        [
            "gemini-3.8-flash-high",
            "gemini-3.8-flash-medium",
            "claude-sonnet-4-6"
        ]
    );
    assert_eq!(models[2].label, "Claude Sonnet 4.6 (Thinking)");
}

#[test]
fn detect_reports_missing_cli() {
    let detection = AgyProvider::with_command("nonexistent_binary_xyz_123")
        .detect()
        .unwrap();
    assert!(!detection.installed && !detection.authenticated && !detection.available);
    assert_eq!(detection.version, None);
}

#[test]
fn detect_reports_version_and_auth() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    let detection = provider.detect().unwrap();
    assert!(detection.installed && detection.authenticated && detection.available);
    assert_eq!(detection.version.as_deref(), Some("1.4.5"));
    assert_eq!(detection.warning, None);

    provider.set_env("OXIDE_FAKE_LOGGED_IN", "0");
    let detection = provider.detect().unwrap();
    assert!(detection.installed && !detection.authenticated && !detection.available);
}

#[test]
fn detect_warns_but_does_not_block_outside_the_pinned_range() {
    let fake = fake_agy();
    let mut provider = AgyProvider::with_command(fake.command());
    provider.set_env("OXIDE_FAKE_VERSION", "2.0.1");
    let detection = provider.detect().unwrap();
    assert!(detection.available);
    assert!(detection.warning.unwrap().contains("2.0.1"));
}
