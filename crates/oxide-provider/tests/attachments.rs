//! How each adapter puts Attachments on the wire, against the fake CLIs.
#![cfg(unix)]

use oxide_provider::agy::AgyProvider;
use oxide_provider::claude::ClaudeCodeProvider;
use oxide_provider::codex::CodexProvider;
use oxide_provider::{
    Attachment, AttachmentKind, PermissionMode, PromptSegment, Provider, ProviderEvent,
    StartContext, TurnStatus,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

mod support;

fn context(dir: &Path) -> StartContext {
    StartContext {
        working_dir: dir.into(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    }
}

fn stored(
    dir: &Path,
    name: &str,
    kind: AttachmentKind,
    media_type: &str,
    bytes: &[u8],
) -> PromptSegment {
    let folder = dir.join("attachments").join(format!("id-{name}"));
    std::fs::create_dir_all(&folder).unwrap();
    let path = folder.join(name);
    std::fs::write(&path, bytes).unwrap();
    PromptSegment::Attachment(Attachment {
        id: format!("id-{name}"),
        name: name.into(),
        kind,
        media_type: media_type.into(),
        size_bytes: bytes.len() as u64,
        path,
    })
}

fn wait_for_turn(rx: &crossbeam_channel::Receiver<ProviderEvent>) {
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(10)) {
        if let ProviderEvent::TurnCompleted { status, .. } = event {
            assert_eq!(status, TurnStatus::Completed);
            return;
        }
    }
    panic!("turn did not complete");
}

fn wire(log: &Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

mod claude {
    use super::*;

    fn run(segments: &[PromptSegment], dir: &Path) -> (Value, Vec<Value>) {
        let log = dir.join("wire.log");
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
        let mut provider = ClaudeCodeProvider::with_command(script.to_str().unwrap());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        provider.allow_attachments_dir(&dir.join("attachments"));
        let rx = provider.start(&context(dir)).unwrap();
        provider.send_prompt_with_segments(segments).unwrap();
        wait_for_turn(&rx);
        provider.shutdown().unwrap();
        let entries = wire(&log);
        let user = entries
            .iter()
            .find(|e| e["type"] == "stdin" && e["data"]["type"] == "user")
            .expect("a user message reached the CLI")["data"]["message"]
            .clone();
        (user, entries)
    }

    #[test]
    fn text_only_prompts_stay_a_plain_string() {
        let dir = tempfile::tempdir().unwrap();
        let (message, _) = run(&[PromptSegment::text("hello")], dir.path());
        assert_eq!(message["content"], "hello");
    }

    #[test]
    fn images_pdfs_and_text_files_are_native_blocks_at_their_place() {
        let dir = tempfile::tempdir().unwrap();
        let segments = [
            PromptSegment::text("Compare "),
            stored(
                dir.path(),
                "a.png",
                AttachmentKind::Image,
                "image/png",
                b"PNG",
            ),
            PromptSegment::text(" with "),
            stored(
                dir.path(),
                "spec.pdf",
                AttachmentKind::Pdf,
                "application/pdf",
                b"%PDF",
            ),
            PromptSegment::text(" and "),
            stored(
                dir.path(),
                "notes.md",
                AttachmentKind::Text,
                "text/markdown",
                b"# Notes",
            ),
            PromptSegment::text("!"),
        ];
        let (message, _) = run(&segments, dir.path());
        let content = message["content"].as_array().unwrap();
        let shape: Vec<String> = content
            .iter()
            .map(|b| match b["type"].as_str().unwrap() {
                "text" => format!("text:{}", b["text"].as_str().unwrap()),
                other => other.to_string(),
            })
            .collect();
        assert_eq!(
            shape,
            [
                "text:Compare [Attachment: a.png]",
                "image",
                "text: with [Attachment: spec.pdf]",
                "document",
                "text: and [Attachment: notes.md]",
                "document",
                "text:!",
            ]
        );
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "UE5H");
        assert_eq!(content[3]["source"]["media_type"], "application/pdf");
        assert_eq!(content[5]["source"]["type"], "text");
        assert_eq!(content[5]["source"]["data"], "# Notes");
    }

    #[test]
    fn other_kinds_and_unsupported_images_are_path_references() {
        let dir = tempfile::tempdir().unwrap();
        let sheet = stored(
            dir.path(),
            "data.xlsx",
            AttachmentKind::Other,
            "application/octet-stream",
            b"PK",
        );
        let bmp = stored(
            dir.path(),
            "old.bmp",
            AttachmentKind::Image,
            "image/bmp",
            b"BM",
        );
        let sheet_path = match &sheet {
            PromptSegment::Attachment(a) => a.path.clone(),
            _ => unreachable!(),
        };
        let (message, _) = run(&[sheet, bmp], dir.path());
        let content = message["content"].as_array().unwrap();
        assert_eq!(
            content.len(),
            1,
            "path references are plain text: {content:?}"
        );
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.starts_with(&format!(
            "[Attachment: data.xlsx] (file: {})",
            sheet_path.display()
        )));
        assert!(text.contains("[Attachment: old.bmp] (file: "));
    }

    #[test]
    fn a_file_that_would_pass_the_stdin_cap_falls_back_to_a_path_reference() {
        let dir = tempfile::tempdir().unwrap();
        let big = vec![b'x'; 7_000_000];
        let segments = [stored(
            dir.path(),
            "big.pdf",
            AttachmentKind::Pdf,
            "application/pdf",
            &big,
        )];
        let (message, _) = run(&segments, dir.path());
        let content = message["content"].as_array().unwrap();
        assert!(content.iter().all(|b| b["type"] == "text"), "{content:?}");
        assert!(content[0]["text"].as_str().unwrap().contains("(file: "));
    }

    #[test]
    fn the_attachments_folder_is_granted_to_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let (_, entries) = run(&[PromptSegment::text("hi")], dir.path());
        let args: Vec<&str> = entries
            .iter()
            .filter(|e| e["type"] == "argv")
            .flat_map(|e| e["args"].as_array().unwrap().iter())
            .map(|a| a.as_str().unwrap())
            .collect();
        let at = args
            .iter()
            .position(|a| *a == "--add-dir")
            .expect("--add-dir");
        assert_eq!(
            args[at + 1],
            dir.path().join("attachments").to_str().unwrap()
        );
    }
}

mod codex {
    use super::*;

    #[test]
    fn images_are_local_image_items_and_documents_are_path_references() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("wire.log");
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");
        let mut provider = CodexProvider::with_command(script.to_str().unwrap());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        let image = stored(
            dir.path(),
            "shot.png",
            AttachmentKind::Image,
            "image/png",
            b"PNG",
        );
        let doc = stored(
            dir.path(),
            "spec.pdf",
            AttachmentKind::Pdf,
            "application/pdf",
            b"%PDF",
        );
        let (image_path, doc_path) = match (&image, &doc) {
            (PromptSegment::Attachment(i), PromptSegment::Attachment(d)) => {
                (i.path.clone(), d.path.clone())
            }
            _ => unreachable!(),
        };
        let rx = provider.start(&context(dir.path())).unwrap();
        provider
            .send_prompt_with_segments(&[
                PromptSegment::text("See "),
                image,
                PromptSegment::text(" and "),
                doc,
                PromptSegment::text("."),
            ])
            .unwrap();
        wait_for_turn(&rx);
        provider.shutdown().unwrap();

        let request = wire(&log)
            .into_iter()
            .find(|e| e["type"] == "stdin" && e["data"]["method"] == "turn/start")
            .expect("turn/start request");
        let input = request["data"]["params"]["input"].as_array().unwrap();
        assert_eq!(input.len(), 3, "{input:?}");
        assert_eq!(input[0]["text"], "See [Attachment: shot.png]");
        assert_eq!(input[1]["type"], "localImage");
        assert_eq!(input[1]["path"], image_path.to_str().unwrap());
        assert_eq!(
            input[2]["text"],
            format!(
                " and [Attachment: spec.pdf] (file: {}).",
                doc_path.display()
            )
        );
    }
}

mod agy {
    use super::*;

    #[test]
    fn every_attachment_is_a_path_reference_and_the_folder_is_added() {
        let dir = tempfile::tempdir().unwrap();
        let fake = support::fake_cli("agy");
        let log = dir.path().join("wire.log");
        let mut provider = AgyProvider::with_command(fake.command());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        provider.allow_attachments_dir(&dir.path().join("attachments"));
        let image = stored(
            dir.path(),
            "shot.png",
            AttachmentKind::Image,
            "image/png",
            b"PNG",
        );
        let image_path = match &image {
            PromptSegment::Attachment(a) => a.path.clone(),
            _ => unreachable!(),
        };
        let rx = provider.start(&context(dir.path())).unwrap();
        provider
            .send_prompt_with_segments(&[
                PromptSegment::text("Look at "),
                image,
                PromptSegment::text(" please"),
            ])
            .unwrap();
        wait_for_turn(&rx);
        provider.shutdown().unwrap();

        let entries = wire(&log);
        let prompt = entries.iter().find(|e| e["type"] == "prompt").unwrap();
        assert_eq!(
            prompt["prompt"],
            format!(
                "Look at [Attachment: shot.png] (file: {}) please",
                image_path.display()
            )
        );
        let args: Vec<&str> = entries
            .iter()
            .filter(|e| e["type"] == "argv")
            .flat_map(|e| e["args"].as_array().unwrap().iter())
            .map(|a| a.as_str().unwrap())
            .collect();
        let at = args
            .iter()
            .position(|a| *a == "--add-dir")
            .expect("--add-dir");
        assert_eq!(
            args[at + 1],
            dir.path().join("attachments").to_str().unwrap()
        );
    }
}
