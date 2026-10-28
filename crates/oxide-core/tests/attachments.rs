//! Attachments through the Core API, with a fake Provider recording what it was sent.

use oxide_core::{AttachmentKind, Core, PermissionMode, PromptInput, PromptSegment, TurnStatus};
use oxide_provider::{FakeProvider, FakeRecorder};
use std::time::Duration;
use tempfile::{TempDir, tempdir};

fn core_with_thread() -> (TempDir, Core, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    std::fs::create_dir_all(dir.path().join("my-project/.git")).unwrap();
    let project = core
        .add_project(&dir.path().join("my-project").to_string_lossy())
        .unwrap();
    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    (dir, core, thread.id)
}

fn with_scripted_fake(core: &Core, thread: u32) -> FakeRecorder {
    let fake = FakeProvider::scripted();
    let recorder = fake.recorder();
    core.register_fake_provider(thread, fake);
    recorder
}

fn text(t: &str) -> PromptInput {
    PromptInput::Text { text: t.into() }
}

fn attachment(id: &str) -> PromptInput {
    PromptInput::Attachment { id: id.into() }
}

fn wait_for_turns(core: &Core, thread: u32, count: usize) {
    for _ in 0..500 {
        let snapshot = core.get_thread_snapshot(thread).unwrap();
        if snapshot.turns.len() >= count
            && snapshot
                .turns
                .iter()
                .all(|t| t.status == TurnStatus::Completed)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the Turns never completed");
}

fn message(error: oxide_core::Error) -> String {
    error.to_string()
}

#[test]
fn a_file_is_stored_under_its_original_name_and_same_names_stay_apart() {
    let (dir, core, _) = core_with_thread();
    let source = dir.path().join("screenshot.png");
    std::fs::write(&source, b"\x89PNG\r\n\x1a\nfirst").unwrap();

    let first = core.attach_path(&source).unwrap();
    std::fs::write(&source, b"\x89PNG\r\n\x1a\nsecond!").unwrap();
    let second = core.attach_path(&source).unwrap();

    assert_eq!(first.name, "screenshot.png");
    assert_eq!(second.name, "screenshot.png");
    assert_ne!(first.id, second.id);
    assert_ne!(first.path, second.path);
    assert!(first.path.starts_with(dir.path().join("attachments")));
    assert_eq!(first.path.file_name().unwrap(), "screenshot.png");
    assert_eq!(first.kind, AttachmentKind::Image);
    assert_eq!(first.media_type, "image/png");
    assert_eq!(first.size_bytes, 13);
    assert_eq!(
        std::fs::read(&second.path).unwrap(),
        b"\x89PNG\r\n\x1a\nsecond!"
    );
    // The original is untouched.
    assert!(source.exists());
}

#[test]
fn kinds_are_decided_from_extension_and_content() {
    let (dir, core, _) = core_with_thread();
    let case = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        core.attach_path(&path).unwrap().kind
    };
    assert_eq!(case("spec.pdf", b"%PDF-1.7 ..."), AttachmentKind::Pdf);
    assert_eq!(case("notes.md", b"# Notes\n"), AttachmentKind::Text);
    assert_eq!(
        case("Makefile", b"all:\n\tcargo build\n"),
        AttachmentKind::Text
    );
    assert_eq!(
        case("data.xlsx", b"PK\x03\x04\x00\x00"),
        AttachmentKind::Other
    );
    assert_eq!(case("renamed.png", b"plain words"), AttachmentKind::Text);
}

#[test]
fn pasted_bytes_keep_their_name_or_get_one() {
    let (_dir, core, _) = core_with_thread();
    let named = core
        .attach_bytes(Some("diagram.png"), b"\x89PNG\r\n\x1a\n")
        .unwrap();
    assert_eq!(named.name, "diagram.png");

    let first = core.attach_bytes(None, b"\x89PNG\r\n\x1a\n").unwrap();
    let second = core.attach_bytes(None, b"\xFF\xD8\xFF\xE0").unwrap();
    assert!(first.name.starts_with("pasted-image-") && first.name.ends_with(".png"));
    assert!(second.name.starts_with("pasted-image-") && second.name.ends_with(".jpg"));
    assert_ne!(first.name, second.name);
}

#[test]
fn a_name_cannot_climb_out_of_the_attachments_folder() {
    let (dir, core, _) = core_with_thread();
    let stored = core.attach_bytes(Some("../../escape.txt"), b"x").unwrap();
    assert_eq!(stored.name, "escape.txt");
    assert!(stored.path.starts_with(dir.path().join("attachments")));
    assert!(!dir.path().join("escape.txt").exists());
}

#[test]
fn too_large_folders_and_unreadable_files_are_refused_each_with_its_own_reason() {
    let (dir, core, _) = core_with_thread();

    let big = vec![0u8; 25 * 1024 * 1024 + 1];
    let too_large = message(core.attach_bytes(Some("huge.bin"), &big).unwrap_err());
    assert!(
        too_large.contains("huge.bin") && too_large.contains("too large"),
        "{too_large}"
    );

    let folder = dir.path().join("a-folder");
    std::fs::create_dir(&folder).unwrap();
    let is_folder = message(core.attach_path(&folder).unwrap_err());
    assert!(
        is_folder.contains("a-folder") && is_folder.contains("folder"),
        "{is_folder}"
    );

    let gone = message(core.attach_path(&dir.path().join("gone.txt")).unwrap_err());
    assert!(
        gone.contains("gone.txt") && gone.contains("can't be read"),
        "{gone}"
    );

    // Nothing from a refused file is left behind.
    let leftovers = std::fs::read_dir(dir.path().join("attachments"))
        .map(|d| d.count())
        .unwrap_or(0);
    assert_eq!(leftovers, 0);
}

#[cfg(unix)]
#[test]
fn a_file_without_permission_is_refused_as_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, core, _) = core_with_thread();
    let secret = dir.path().join("secret.txt");
    std::fs::write(&secret, b"s").unwrap();
    std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read(&secret).is_ok() {
        return; // running as root: permissions don't apply
    }
    let error = message(core.attach_path(&secret).unwrap_err());
    assert!(
        error.contains("secret.txt") && error.contains("permission denied"),
        "{error}"
    );
}

#[test]
fn a_prompt_with_too_many_attachments_is_refused_before_a_turn_starts() {
    let (_dir, core, thread) = core_with_thread();
    let recorder = with_scripted_fake(&core, thread);
    let mut prompt = Vec::new();
    for n in 0..11 {
        let a = core.attach_bytes(Some(&format!("f{n}.txt")), b"x").unwrap();
        prompt.push(attachment(&a.id));
    }

    let error = message(core.send_prompt_segments(thread, &prompt).unwrap_err());

    assert!(error.contains("at most 10"), "{error}");
    assert!(recorder.prompts().is_empty());
}

#[test]
fn only_stored_attachments_can_be_referenced() {
    let (dir, core, thread) = core_with_thread();
    with_scripted_fake(&core, thread);
    std::fs::write(dir.path().join("secret.txt"), b"s").unwrap();
    let stored = core.attach_bytes(Some("a.txt"), b"x").unwrap();

    for id in [
        "../my-project",
        "..",
        "does-not-exist",
        "",
        &format!("{}/../..", stored.id),
    ] {
        assert!(
            core.send_prompt_segments(thread, &[text("x"), attachment(id)])
                .is_err(),
            "{id:?} should be refused"
        );
    }
}

#[test]
fn a_sent_prompt_reaches_the_provider_and_the_transcript_as_ordered_segments() {
    let (_dir, core, thread) = core_with_thread();
    let recorder = with_scripted_fake(&core, thread);
    let image = core
        .attach_bytes(Some("immagine.png"), b"\x89PNG\r\n\x1a\n")
        .unwrap();
    let doc = core.attach_bytes(Some("notes.md"), b"# hi").unwrap();

    core.send_prompt_segments(
        thread,
        &[
            text("Ciao prova "),
            attachment(&image.id),
            text(" 123!!! e "),
            attachment(&doc.id),
        ],
    )
    .unwrap();
    wait_for_turns(&core, thread, 1);

    let sent = &recorder.segments()[0];
    assert_eq!(sent.len(), 4);
    assert_eq!(sent[0], PromptSegment::text("Ciao prova "));
    assert_eq!(sent[1], PromptSegment::Attachment(image.clone()));
    assert_eq!(sent[2], PromptSegment::text(" 123!!! e "));
    assert_eq!(sent[3], PromptSegment::Attachment(doc.clone()));

    let snapshot = core.get_thread_snapshot(thread).unwrap();
    let turn = &snapshot.turns[0];
    assert_eq!(turn.prompt, "Ciao prova [immagine.png] 123!!! e [notes.md]");
    assert_eq!(turn.segments, *sent);
    // The sidebar title reads the same plain rendering.
    assert!(
        snapshot
            .thread
            .title
            .as_deref()
            .unwrap()
            .contains("[immagine.png]")
    );
}

#[test]
fn a_prompt_made_only_of_attachments_is_sent() {
    let (_dir, core, thread) = core_with_thread();
    let recorder = with_scripted_fake(&core, thread);
    let a = core.attach_bytes(Some("a.txt"), b"x").unwrap();

    core.send_prompt_segments(thread, &[attachment(&a.id)])
        .unwrap();
    wait_for_turns(&core, thread, 1);

    assert_eq!(recorder.prompts(), vec!["[a.txt]"]);
}

#[test]
fn oxide_run_slash_commands_refuse_attachments_but_provider_ones_take_them() {
    let (_dir, core, thread) = core_with_thread();
    let recorder = with_scripted_fake(&core, thread);
    let a = core
        .attach_bytes(Some("diff.png"), b"\x89PNG\r\n\x1a\n")
        .unwrap();

    for command in [
        "/model",
        "/model gpt-5",
        "/effort high",
        "/clear",
        "/permissions",
    ] {
        let error = core
            .send_prompt_segments(thread, &[text(&format!("{command} ")), attachment(&a.id)])
            .unwrap_err();
        let word = command.split_whitespace().next().unwrap();
        assert!(
            message(error).contains(&format!("can't be sent with {word}")),
            "{command}"
        );
    }
    assert!(recorder.prompts().is_empty());

    core.send_prompt_segments(thread, &[text("/review "), attachment(&a.id)])
        .unwrap();
    wait_for_turns(&core, thread, 1);
    assert_eq!(recorder.prompts(), vec!["/review [diff.png]"]);
}

#[test]
fn a_provider_that_cannot_read_the_files_fails_the_send_before_any_turn_starts() {
    let (_dir, core, thread) = core_with_thread();
    let mut fake = FakeProvider::scripted();
    fake.refuse_attachments("Antigravity CLI can't read files outside the Project.");
    let recorder = fake.recorder();
    core.register_fake_provider(thread, fake);
    let a = core.attach_bytes(Some("a.txt"), b"x").unwrap();

    let error = message(
        core.send_prompt_segments(thread, &[text("see "), attachment(&a.id)])
            .unwrap_err(),
    );

    assert!(
        error.contains("can't read files outside the Project"),
        "{error}"
    );
    assert!(recorder.prompts().is_empty());
    assert!(core.get_thread_snapshot(thread).unwrap().turns.is_empty());
    // Text-only prompts still go through afterwards.
    core.send_prompt(thread, "plain").unwrap();
    wait_for_turns(&core, thread, 1);
}

#[test]
fn a_discarded_attachment_is_forgotten() {
    let (dir, core, _) = core_with_thread();
    let a = core.attach_bytes(Some("a.txt"), b"x").unwrap();
    assert!(a.path.exists());

    core.discard_attachment(&a.id);

    assert!(!dir.path().join("attachments").join(&a.id).exists());
    // Discarding what isn't there, or isn't an id, is harmless.
    core.discard_attachment(&a.id);
    core.discard_attachment("../my-project");
    assert!(dir.path().join("my-project").exists());
}

#[test]
fn deleting_a_thread_deletes_its_attachments_and_only_its_own() {
    let (dir, core, thread) = core_with_thread();
    with_scripted_fake(&core, thread);
    let mine = core.attach_bytes(Some("mine.txt"), b"x").unwrap();
    let unsent = core.attach_bytes(Some("unsent.txt"), b"x").unwrap();
    core.send_prompt_segments(thread, &[attachment(&mine.id)])
        .unwrap();
    wait_for_turns(&core, thread, 1);

    core.delete_thread(thread, false).unwrap();

    assert!(!dir.path().join("attachments").join(&mine.id).exists());
    assert!(
        unsent.path.exists(),
        "an unsent Attachment belongs to no Thread yet"
    );
}

#[test]
fn turns_stored_before_attachments_were_inline_load_as_text_then_attachments() {
    let (dir, core, thread) = core_with_thread();
    let legacy_dir = dir.path().join("attachments");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    let legacy_file = legacy_dir.join("1700000000000000000-0.png");
    std::fs::write(&legacy_file, b"\x89PNG\r\n\x1a\n").unwrap();
    {
        let db = rusqlite::Connection::open(dir.path().join("oxide.db")).unwrap();
        db.execute(
            "INSERT INTO turns (thread_id, turn_index, prompt, attachments, status)
             VALUES (?1, 0, 'look at this', ?2, 'completed')",
            rusqlite::params![
                thread,
                serde_json::to_string(&[legacy_file.to_string_lossy()]).unwrap()
            ],
        )
        .unwrap();
    }

    let snapshot = core.get_thread_snapshot(thread).unwrap();
    let segments = &snapshot.turns[0].segments;

    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0], PromptSegment::text("look at this"));
    let PromptSegment::Attachment(a) = &segments[1] else {
        panic!("expected an Attachment, got {:?}", segments[1]);
    };
    assert_eq!(a.name, "1700000000000000000-0.png");
    assert_eq!(a.kind, AttachmentKind::Image);
    assert_eq!(a.path, legacy_file);

    // Deleting the Thread still removes the legacy file.
    core.delete_thread(thread, false).unwrap();
    assert!(!legacy_file.exists());
}

#[cfg(unix)]
#[test]
fn startup_removes_old_unreferenced_attachments_and_keeps_the_rest() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let (kept_by_turn, stale, fresh);
    {
        let core = Core::open(home).unwrap();
        core.set_real_time_ticker(false);
        std::fs::create_dir_all(home.join("my-project/.git")).unwrap();
        let project = core
            .add_project(&home.join("my-project").to_string_lossy())
            .unwrap();
        let thread = core
            .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
            .unwrap();
        with_scripted_fake(&core, thread.id);
        kept_by_turn = core.attach_bytes(Some("sent.txt"), b"x").unwrap();
        stale = core.attach_bytes(Some("stale.txt"), b"x").unwrap();
        fresh = core.attach_bytes(Some("fresh.txt"), b"x").unwrap();
        core.send_prompt_segments(thread.id, &[attachment(&kept_by_turn.id)])
            .unwrap();
        wait_for_turns(&core, thread.id, 1);
        core.shutdown();
    }
    let two_days_ago = std::time::SystemTime::now() - Duration::from_secs(48 * 60 * 60);
    for a in [&kept_by_turn, &stale] {
        let folder = a.path.parent().unwrap();
        std::fs::File::open(folder)
            .unwrap()
            .set_modified(two_days_ago)
            .unwrap();
    }

    let _core = Core::open(home).unwrap();

    assert!(kept_by_turn.path.exists(), "a Turn refers to it");
    assert!(!stale.path.exists(), "old and unreferenced");
    assert!(fresh.path.exists(), "too recent to call abandoned");
}
