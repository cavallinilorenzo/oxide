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
