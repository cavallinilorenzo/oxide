use crossbeam_channel::Receiver;
use oxide_core::{
    Core, ItemKind, PermissionMode, RECAP_MAX_CHARS, SequencedThreadEvent, ThreadEvent,
    ThreadStatus,
};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use rusqlite::Connection;
use std::path::Path;
use std::time::Duration;
use tempfile::tempdir;

const SESSION_GONE: &str = "Provider session no longer available";

fn open_core_with_project(dir: &Path) -> (Core, u32) {
    let core = Core::open(dir).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project_id = core.rescan_projects().unwrap()[0].id;
    (core, project_id)
}

fn wait_for(rx: &Receiver<SequencedThreadEvent>, wanted: ThreadEvent) {
    loop {
        let evt = rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted:?}"));
        if evt.event == wanted {
            return;
        }
    }
}

fn completed() -> ThreadEvent {
    ThreadEvent::ThreadStatusChanged {
        status: ThreadStatus::Completed,
    }
}

/// A fake answering each prompt with a Turn holding a tool call and a final agent message.
fn answering_fake(answer: &'static str) -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let events = [
            ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt: prompt.to_string(),
            },
            ProviderEvent::ItemCompleted {
                item_index: 0,
                kind: ItemKind::ToolCall,
                content: "Run cargo test\nTOOL-OUTPUT-NOISE".into(),
                parent_item_index: None,
            },
            ProviderEvent::ItemCompleted {
                item_index: 1,
                kind: ItemKind::AgentMessage,
                content: answer.into(),
                parent_item_index: None,
            },
            ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            },
        ];
        for event in events {
            let _ = sender.send(event);
        }
    });
    fake
}

/// A Thread with one finished Turn and a stored Provider session id.
fn thread_with_session(core: &Core, project_id: u32, dir: &Path) -> u32 {
    let thread = core
        .create_thread(
            project_id,
            "fake",
            Some("opus".into()),
            Some("high".into()),
            PermissionMode::Ask,
        )
        .unwrap();
    core.register_fake_provider(thread.id, answering_fake("The fix is in."));
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "fix the bug").unwrap();
    core.tick_thread(thread.id);
    wait_for(&rx, completed());
    Connection::open(dir.join("oxide.db"))
        .unwrap()
        .execute(
            "UPDATE threads SET provider_session_id = 'gone' WHERE id = ?1",
            [thread.id],
        )
        .unwrap();
    thread.id
}

fn lose_session(id: u32, dir: &Path) {
    Connection::open(dir.join("oxide.db"))
        .unwrap()
        .execute("UPDATE threads SET session_lost = 1 WHERE id = ?1", [id])
        .unwrap();
}

#[test]
fn only_a_thread_with_a_lost_session_can_be_continued_once() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let id = thread_with_session(&core, project_id, dir.path());
    assert!(core.continue_thread(id).is_err(), "its session is fine");

    lose_session(id, dir.path());
    core.continue_thread(id).unwrap();
    assert!(core.continue_thread(id).is_err(), "already continued");
}

#[test]
fn resuming_a_vanished_session_sends_the_thread_to_error() {
    let dir = tempdir().unwrap();
    let id = {
        let (core, project_id) = open_core_with_project(dir.path());
        thread_with_session(&core, project_id, dir.path())
    };

    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let mut fake = FakeProvider::default();
    fake.fail_resume_with_session_not_found();
    core.register_fake_provider(id, fake);
    let (_, rx) = core.subscribe_thread(id).unwrap();

    let err = core.send_prompt(id, "and then?").unwrap_err();
    assert!(err.to_string().contains(SESSION_GONE), "{err}");
    wait_for(
        &rx,
        ThreadEvent::Error {
            message: SESSION_GONE.into(),
        },
    );
    let snapshot = core.get_thread_snapshot(id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Error);
    assert!(snapshot.thread.session_lost);
    assert_eq!(snapshot.turns.len(), 1, "the Transcript stays readable");
}

#[test]
fn continuing_creates_a_linked_thread_with_a_recap_of_prompts_and_answers() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let id = thread_with_session(&core, project_id, dir.path());
    lose_session(id, dir.path());

    let continued = core.continue_thread(id).unwrap();
    let new = &continued.thread;
    assert_ne!(new.id, id);
    assert_eq!(new.project_id, project_id);
    assert_eq!(new.provider, "fake");
    assert_eq!(new.model.as_deref(), Some("opus"));
    assert_eq!(new.effort.as_deref(), Some("high"));
    assert_eq!(new.permission_mode, PermissionMode::Ask);
    assert_eq!(new.continued_from, Some(id));

    assert!(continued.recap.contains("fix the bug"));
    assert!(continued.recap.contains("The fix is in."));
    assert!(!continued.recap.contains("TOOL-OUTPUT-NOISE"));

    let old = core.get_thread_snapshot(id).unwrap().thread;
    assert_eq!(old.continued_in, Some(new.id));
    assert_eq!(old.continued_from, None);
    let listed = core.list_threads(project_id).unwrap();
    assert_eq!(
        listed.iter().find(|t| t.id == id).unwrap().continued_in,
        Some(new.id)
    );
}

#[test]
fn the_recap_is_cut_to_the_length_cap_keeping_the_latest_exchange() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    core.register_fake_provider(thread.id, answering_fake("answer"));
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, &"x".repeat(RECAP_MAX_CHARS))
        .unwrap();
    core.tick_thread(thread.id);
    wait_for(&rx, completed());
    core.send_prompt(thread.id, "latest question").unwrap();
    core.tick_thread(thread.id);
    wait_for(&rx, completed());

    lose_session(thread.id, dir.path());
    let recap = core.continue_thread(thread.id).unwrap().recap;
    assert!(recap.chars().count() <= RECAP_MAX_CHARS, "{}", recap.len());
    assert!(recap.contains("latest question"));
}
