use oxide_provider::{
    FakeProvider, ItemKind, PermissionMode, Provider, ProviderEvent, TurnStatus,
    contract_suite::verify_provider_contract,
};

mod support;

fn interrupt_and_continue(provider: &mut dyn Provider, ready: impl Fn(&ProviderEvent) -> bool) {
    use oxide_provider::StartContext;
    use std::time::{Duration, Instant};

    let context = StartContext {
        working_dir: ".".into(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };
    let rx = provider.start(&context).unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        provider.send_prompt("interrupt_test").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if ready(&event) {
                break;
            }
        }
        provider.interrupt().unwrap();
        for (index, expected) in [(0, TurnStatus::Interrupted), (1, TurnStatus::Completed)] {
            if index == 1 {
                provider.send_prompt("Hello after interrupt").unwrap();
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap()
                {
                    ProviderEvent::TurnCompleted { turn_index, status } => {
                        assert_eq!((turn_index, status), (index, expected));
                        break;
                    }
                    ProviderEvent::Exited { .. } => panic!("interrupt must preserve the session"),
                    _ => {}
                }
            }
        }
    }));
    provider.shutdown().unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn claude_interrupts_without_signals_and_accepts_the_next_turn() {
    let fake_cli = support::fake_cli("claude");
    let mut provider = oxide_provider::claude::ClaudeCodeProvider::with_command(fake_cli.command());
    interrupt_and_continue(
        &mut provider,
        |e| matches!(e, ProviderEvent::Unknown { raw } if raw.contains("interrupt_ready")),
    );
}

#[test]
fn codex_interrupts_the_active_turn_and_accepts_the_next_turn() {
    let fake_cli = support::fake_cli("codex");
    let mut provider = oxide_provider::codex::CodexProvider::with_command(fake_cli.command());
    interrupt_and_continue(
        &mut provider,
        |e| matches!(e, ProviderEvent::Unknown { raw } if raw.contains("interrupt_ready")),
    );
}

#[test]
fn agy_interrupts_the_process_tree_and_accepts_the_next_turn() {
    let fake_cli = support::fake_cli("agy");
    let mut provider = oxide_provider::agy::AgyProvider::with_command(fake_cli.command());
    interrupt_and_continue(&mut provider, |e| {
        matches!(e, ProviderEvent::SessionInfo { .. })
    });
}

#[test]
fn fake_provider_satisfies_contract_capabilities_and_detect() {
    let provider = FakeProvider::default();
    let caps = provider.capabilities();
    assert!(
        caps.supported_permission_modes
            .contains(&PermissionMode::Ask)
    );
    assert!(caps.interactive_approvals);

    let detection = provider.detect().expect("detect should succeed");
    assert!(detection.available);
}

#[test]
fn fake_provider_passes_shared_contract_suite() {
    verify_provider_contract(|| {
        let fake = FakeProvider::default();
        let sender = fake.sender();
        fake.on_prompt(move |prompt| {
            let s = sender.clone();
            let prompt = prompt.to_string();
            std::thread::spawn(move || {
                let _ = s.send(ProviderEvent::SessionInfo {
                    session_id: "fake-session-123".into(),
                });
                let _ = s.send(ProviderEvent::TurnStarted {
                    turn_index: 0,
                    prompt,
                });
                let _ = s.send(ProviderEvent::ItemStarted {
                    parent_item_index: None,
                    item_index: 0,
                    kind: ItemKind::AgentMessage,
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
                    kind: ItemKind::AgentMessage,
                    content: "Hello world!".into(),
                });
                let _ = s.send(ProviderEvent::Unknown {
                    raw: r#"{"type":"custom_unrecognized_event","data":123}"#.into(),
                });
                let _ = s.send(ProviderEvent::TurnCompleted {
                    turn_index: 0,
                    status: TurnStatus::Completed,
                });
            });
        });
        fake
    });
}

#[test]
fn claude_code_provider_passes_shared_contract_suite() {
    let fake_cli = support::fake_cli("claude");
    verify_provider_contract(|| {
        oxide_provider::claude::ClaudeCodeProvider::with_command(fake_cli.command())
    });
}

#[test]
fn codex_provider_passes_shared_contract_suite() {
    let fake_cli = support::fake_cli("codex");
    verify_provider_contract(|| {
        oxide_provider::codex::CodexProvider::with_command(fake_cli.command())
    });
}

#[cfg(windows)]
#[test]
fn providers_detect_and_run_shims_from_their_search_path() {
    use oxide_provider::{agy::AgyProvider, claude::ClaudeCodeProvider, codex::CodexProvider};

    for extension in ["cmd", "bat"] {
        let dir = tempfile::Builder::new()
            .prefix("oxide CLI shims ")
            .tempdir()
            .unwrap();
        for name in ["claude", "codex", "agy"] {
            let script = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("fixtures/{name}/fake_{name}.py"));
            std::fs::write(
                dir.path().join(format!("oxide-{name}.{extension}")),
                format!(
                    "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                    support::python().display(),
                    script.display()
                ),
            )
            .unwrap();
        }
        let path = std::env::join_paths(
            [dir.path().to_path_buf()]
                .into_iter()
                .chain(std::env::split_paths(&std::env::var_os("PATH").unwrap())),
        )
        .unwrap()
        .into_string()
        .unwrap();
        let pathext = format!(".{extension};.EXE");
        let mut claude = ClaudeCodeProvider::with_command("oxide-claude");
        claude.set_env("PATH", &path);
        claude.set_env("PATHEXT", &pathext);
        verify_provider_contract(|| claude);

        let mut codex = CodexProvider::with_command("oxide-codex");
        codex.set_env("PATH", &path);
        codex.set_env("PATHEXT", &pathext);
        verify_provider_contract(|| codex);

        let mut agy = AgyProvider::with_command("oxide-agy");
        agy.set_env("PATH", &path);
        agy.set_env("PATHEXT", &pathext);
        verify_provider_contract(|| agy);
    }
}

#[cfg(windows)]
#[test]
fn provider_detection_honours_pathext_order_and_explicit_paths() {
    use oxide_provider::claude::ClaudeCodeProvider;
    let dir = tempfile::Builder::new()
        .prefix("oxide CLI order ")
        .tempdir()
        .unwrap();
    for (extension, version) in [("cmd", "1.0.0"), ("bat", "2.0.0")] {
        std::fs::write(
            dir.path().join(format!("oxide-claude.{extension}")),
            format!(
                "@echo off\r\nif \"%~1\"==\"--version\" echo claude {version}\r\nexit /b 0\r\n"
            ),
        )
        .unwrap();
    }
    let mut provider = ClaudeCodeProvider::with_command("oxide-claude");
    provider.set_env("PATH", dir.path().to_str().unwrap());
    provider.set_env("PATHEXT", ".BAT;.CMD;.EXE");
    assert_eq!(provider.detect().unwrap().version.as_deref(), Some("2.0.0"));

    let mut provider =
        ClaudeCodeProvider::with_command(dir.path().join("oxide-claude.cmd").to_str().unwrap());
    provider.set_env("PATHEXT", ".BAT;.EXE");
    assert_eq!(provider.detect().unwrap().version.as_deref(), Some("1.0.0"));
}

#[cfg(windows)]
#[test]
fn provider_detection_resolves_native_executables() {
    // Python is a native CLI with a version probe, so this also catches accidental shell use.
    let mut provider = oxide_provider::claude::ClaudeCodeProvider::with_command("python");
    provider.set_env(
        "PATH",
        support::python().parent().unwrap().to_str().unwrap(),
    );
    provider.set_env("PATHEXT", ".EXE");
    let detection = provider.detect().unwrap();
    assert!(detection.installed);
    assert!(!detection.authenticated);
}

#[test]
fn fake_provider_handles_approval_and_permission_mode() {
    use oxide_provider::{ApprovalDecision, ApprovalKind};
    use std::sync::{Arc, Mutex};

    let mut provider = FakeProvider::default();
    let handled = Arc::new(Mutex::new(Vec::new()));
    let handled_clone = handled.clone();

    provider.on_approval(move |id, decision| {
        handled_clone
            .lock()
            .unwrap()
            .push((id.to_string(), decision));
    });

    provider
        .set_permission_mode(PermissionMode::FullAccess)
        .unwrap();

    let evt = ProviderEvent::ApprovalRequested {
        id: "appr-1".into(),
        kind: ApprovalKind::Command,
        summary: "Execute cargo test".into(),
        options: vec!["allow-once".into()],
    };

    let json = serde_json::to_string(&evt).unwrap();
    let parsed: ProviderEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(evt, parsed);

    provider
        .respond_to_approval("appr-1", ApprovalDecision::Allow)
        .unwrap();
    let received = handled.lock().unwrap().clone();
    assert_eq!(
        received,
        vec![("appr-1".to_string(), ApprovalDecision::Allow)]
    );
}
