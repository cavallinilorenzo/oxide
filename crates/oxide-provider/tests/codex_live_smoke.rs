use oxide_provider::codex::CodexProvider;
use oxide_provider::{PermissionMode, Provider, ProviderEvent, StartContext, TurnStatus};
use std::path::PathBuf;
use std::time::Duration;

#[test]
#[ignore = "Opt-in live smoke test against real installed codex CLI. Run with `cargo test --test codex_live_smoke -- --ignored`"]
fn live_smoke_thread_with_real_codex_cli() {
    let mut provider = CodexProvider::new();
    let detection = match provider.detect() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Skipping live test: detect error: {e}");
            return;
        }
    };

    if !detection.available {
        eprintln!(
            "Skipping live test: real codex is not installed or not logged in ({:?})",
            detection
        );
        return;
    }

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };

    let rx = provider
        .start(&context)
        .expect("start must succeed with real codex CLI");
    provider
        .send_prompt("Respond with exactly the single word: PONG")
        .expect("send_prompt must succeed");

    let mut turn_completed = false;
    let timeout = Duration::from_secs(60);
    while let Ok(evt) = rx.recv_timeout(timeout) {
        if let ProviderEvent::TurnCompleted { status, .. } = evt {
            assert_eq!(status, TurnStatus::Completed);
            turn_completed = true;
            break;
        }
    }

    assert!(turn_completed, "live turn must complete successfully");
    provider.shutdown().expect("shutdown must succeed");
}
