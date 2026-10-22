use oxide_provider::{
    FakeProvider, ItemKind, PermissionMode, Provider, ProviderEvent, TurnStatus,
    contract_suite::verify_provider_contract,
};

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
    use std::path::PathBuf;
    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
    verify_provider_contract(|| {
        oxide_provider::claude::ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap())
    });
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
