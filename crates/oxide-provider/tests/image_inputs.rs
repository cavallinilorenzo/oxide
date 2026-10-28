use oxide_provider::{PermissionMode, Provider, ProviderEvent, StartContext};
use std::time::Duration;
mod support;
fn context() -> StartContext {
    StartContext {
        working_dir: std::env::temp_dir(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    }
}
fn finish(events: &crossbeam_channel::Receiver<ProviderEvent>) {
    while let Ok(event) = events.recv_timeout(Duration::from_secs(5)) {
        if matches!(event, ProviderEvent::TurnCompleted { .. }) {
            return;
        }
    }
    panic!("image turn did not finish");
}
fn wire(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
#[test]
fn claude_sends_image_bytes_in_a_multimodal_user_message() {
    let fake = support::fake_cli("claude");
    let temp = tempfile::tempdir().unwrap();
    let log = temp.path().join("wire.jsonl");
    let image = temp.path().join("input.png");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();
    let mut provider = oxide_provider::claude::ClaudeCodeProvider::with_command(fake.command());
    provider.set_env("OXIDE_WIRE_LOG", log.to_string_lossy().as_ref());
    let events = provider.start(&context()).unwrap();
    assert!(provider.capabilities().image_attachments);
    provider
        .send_prompt_with_images("inspect", &[image])
        .unwrap();
    finish(&events);
    provider.shutdown().unwrap();
    let entries = wire(&log);
    let message = entries
        .iter()
        .find(|entry| entry["data"]["type"] == "user")
        .unwrap();
    assert_eq!(message["data"]["message"]["content"][0]["text"], "inspect");
    assert_eq!(
        message["data"]["message"]["content"][1]["source"]["media_type"],
        "image/png"
    );
    assert_eq!(
        message["data"]["message"]["content"][1]["source"]["data"],
        "iVBORw0KGgo="
    );
}
#[test]
fn antigravity_exposes_only_copies_of_the_selected_images() {
    let fake = support::fake_cli("agy");
    let temp = tempfile::tempdir().unwrap();
    let log = temp.path().join("wire.jsonl");
    let image = temp.path().join("selected.png");
    std::fs::write(&image, b"selected image").unwrap();
    let mut provider = oxide_provider::agy::AgyProvider::with_command(fake.command());
    provider.set_env("OXIDE_WIRE_LOG", log.to_string_lossy().as_ref());
    let events = provider.start(&context()).unwrap();
    provider
        .send_prompt_with_images("inspect", std::slice::from_ref(&image))
        .unwrap();
    finish(&events);
    provider.shutdown().unwrap();
    let entries = wire(&log);
    let argv = entries
        .iter()
        .find(|entry| {
            entry["type"] == "argv"
                && entry["args"]
                    .as_array()
                    .is_some_and(|args| args.iter().any(|arg| arg == "--add-dir"))
        })
        .unwrap();
    let args = argv["args"].as_array().unwrap();
    let index = args.iter().position(|arg| arg == "--add-dir").unwrap();
    assert_ne!(args[index + 1], temp.path().to_string_lossy().as_ref());
    assert_eq!(std::fs::read(&image).unwrap(), b"selected image");
}
