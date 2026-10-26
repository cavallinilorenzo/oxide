use oxide_provider::claude::ClaudeCodeProvider;
use oxide_provider::{PermissionMode, Provider, ProviderEvent, StartContext, TurnStatus};
use std::path::PathBuf;
use std::time::Duration;

#[test]
#[ignore = "Opt-in live smoke test against real installed claude CLI. Run with `cargo test --test claude_live_smoke -- --ignored`"]
fn live_smoke_model_catalog_from_real_claude_cli() {
    let provider = ClaudeCodeProvider::new();
    if !provider.detect().map(|d| d.available).unwrap_or(false) {
        eprintln!("Skipping live test: real claude is not installed or not logged in");
        return;
    }

    let models = provider.models().expect("the CLI must report its models");
    for m in &models {
        eprintln!("{} | {} | legacy={}", m.id, m.name, m.is_legacy);
    }
    assert!(!models.is_empty());
}

#[test]
#[ignore = "Opt-in live smoke test against real installed claude CLI. Run with `cargo test --test claude_live_smoke -- --ignored`"]
fn live_smoke_thread_with_real_claude_cli() {
    let mut provider = ClaudeCodeProvider::new();
    let detection = match provider.detect() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("Skipping live test: detect error: {e}");
            return;
        }
    };

    if !detection.available {
        eprintln!(
            "Skipping live test: real claude is not installed or not logged in ({:?})",
            detection
        );
        return;
    }

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: Some("haiku".into()),
        effort: Some("low".into()),
        permission_mode: PermissionMode::AutoEdit,
    };

    let rx = provider
        .start(&context)
        .expect("start must succeed with real claude CLI");
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
