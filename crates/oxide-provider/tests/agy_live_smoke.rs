use oxide_provider::agy::AgyProvider;
use oxide_provider::{PermissionMode, Provider, ProviderEvent, StartContext, TurnStatus};
use std::path::PathBuf;
use std::time::Duration;

#[test]
#[ignore = "Opt-in live smoke test against the real installed agy CLI. Run with `cargo test --test agy_live_smoke -- --ignored`"]
fn live_smoke_thread_with_real_agy_cli() {
    let mut provider = AgyProvider::new();
    let detection = provider.detect().expect("detect must not error");
    if !detection.available {
        eprintln!("Skipping live test: agy is not installed or not logged in ({detection:?})");
        return;
    }

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };
    let rx = provider.start(&context).expect("start must succeed");

    let mut conversations = Vec::new();
    for prompt in [
        "Respond with exactly the single word: PONG",
        "Respond with exactly the single word: PING",
    ] {
        provider
            .send_prompt(prompt)
            .expect("send_prompt must succeed");
        let mut completed = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_secs(120)) {
            match event {
                ProviderEvent::SessionInfo { session_id } => conversations.push(session_id),
                ProviderEvent::TurnCompleted { status, .. } => {
                    assert_eq!(status, TurnStatus::Completed);
                    completed = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(completed, "live turn must complete");
    }
    assert_eq!(conversations.len(), 2);
    assert_eq!(
        conversations[0], conversations[1],
        "Turns share a conversation"
    );
    provider.shutdown().expect("shutdown must succeed");
}
