use crossbeam_channel::Receiver;
use oxide_core::{
    Core, Notification, PermissionMode, Selection, SequencedThreadEvent, System, ThreadEvent,
    ThreadStatus, TurnStatus,
};
use oxide_provider::{ApprovalKind, FakeProvider, ProviderEvent};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::tempdir;

/// Records what Core asks of the operating system.
#[derive(Default)]
struct FakeSystem {
    log: Mutex<Vec<String>>,
}

impl FakeSystem {
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn push(&self, line: impl Into<String>) {
        self.log.lock().unwrap().push(line.into());
    }
    fn lines_starting(&self, prefix: &str) -> Vec<String> {
        self.log()
            .into_iter()
            .filter(|l| l.starts_with(prefix))
            .collect()
    }
}

impl System for FakeSystem {
    fn hold_activity(&self) {
        self.push("hold");
    }
    fn release_activity(&self) {
        self.push("release");
    }
    fn notify(&self, n: Notification) {
        self.push(format!("notify {} {:?}", n.thread_id, n.kind));
    }
    fn set_badge(&self, count: u32) {
        self.push(format!("badge {count}"));
    }
}

fn open_core(dir: &Path) -> (Core, u32, Arc<FakeSystem>) {
    let core = Core::open(dir).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.join("my-project").join(".git")).unwrap();
    let project_id = core.rescan_projects().unwrap()[0].id;
    let system = Arc::new(FakeSystem::default());
    core.set_system(system.clone());
    (core, project_id, system)
}

fn thread_with_fake(core: &Core, project_id: u32, fake: FakeProvider) -> u32 {
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    thread.id
}

fn wait_for_status(rx: &Receiver<SequencedThreadEvent>, wanted: ThreadStatus) {
    loop {
        let evt = rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted}"));
        if evt.event == (ThreadEvent::ThreadStatusChanged { status: wanted }) {
            return;
        }
    }
}

/// A Provider that starts a Turn and then asks for an Approval.
fn approval_fake() -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender.send(ProviderEvent::ApprovalRequested {
            id: "a1".into(),
            kind: ApprovalKind::Command,
            summary: "Run `ls`".into(),
            options: vec![],
        });
    });
    fake
}

/// A Provider whose Turn finishes right away.
fn finishing_fake() -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
        let _ = sender.send(ProviderEvent::TurnCompleted {
            turn_index: 0,
            status: TurnStatus::Completed,
        });
    });
    fake
}

#[test]
fn the_activity_assertion_is_held_only_while_a_turn_is_working() {
    let dir = tempdir().unwrap();
    let (core, project_id, system) = open_core(dir.path());
    let id = thread_with_fake(&core, project_id, FakeProvider::default());
    let (_, rx) = core.subscribe_thread(id).unwrap();
    assert!(system.log().is_empty(), "nothing held while idle");

    core.send_prompt(id, "go").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    assert_eq!(system.log(), ["hold"]);

    core.interrupt_thread(id).unwrap();
    wait_for_status(&rx, ThreadStatus::Interrupted);
    assert_eq!(system.log(), ["hold", "release"]);
}

#[test]
fn the_assertion_is_held_once_for_many_working_threads() {
    let dir = tempdir().unwrap();
    let (core, project_id, system) = open_core(dir.path());
    let a = thread_with_fake(&core, project_id, FakeProvider::default());
    let b = thread_with_fake(&core, project_id, FakeProvider::default());
    let (_, rx_a) = core.subscribe_thread(a).unwrap();
    let (_, rx_b) = core.subscribe_thread(b).unwrap();
    core.send_prompt(a, "go").unwrap();
    core.send_prompt(b, "go").unwrap();
    wait_for_status(&rx_a, ThreadStatus::Working);
    wait_for_status(&rx_b, ThreadStatus::Working);

    core.interrupt_thread(a).unwrap();
    wait_for_status(&rx_a, ThreadStatus::Interrupted);
    assert_eq!(system.log(), ["hold"], "still held for the other Thread");

    core.interrupt_thread(b).unwrap();
    wait_for_status(&rx_b, ThreadStatus::Interrupted);
    assert_eq!(system.log(), ["hold", "release"]);
}

#[test]
fn completed_notifies_only_while_the_window_is_inactive() {
    let dir = tempdir().unwrap();
    let (core, project_id, system) = open_core(dir.path());
    let focused = thread_with_fake(&core, project_id, finishing_fake());
    let hidden = thread_with_fake(&core, project_id, finishing_fake());
    let (_, rx_focused) = core.subscribe_thread(focused).unwrap();
    let (_, rx_hidden) = core.subscribe_thread(hidden).unwrap();

    core.set_window_active(true);
    core.send_prompt(focused, "go").unwrap();
    wait_for_status(&rx_focused, ThreadStatus::Completed);
    assert!(system.lines_starting("notify").is_empty());

    core.set_window_active(false);
    core.send_prompt(hidden, "go").unwrap();
    wait_for_status(&rx_hidden, ThreadStatus::Completed);
    assert_eq!(
        system.lines_starting("notify"),
        [format!("notify {hidden} Completed")]
    );
}

#[test]
fn needs_input_notifies_only_while_the_window_is_inactive() {
    let dir = tempdir().unwrap();
    let (core, project_id, system) = open_core(dir.path());
    let focused = thread_with_fake(&core, project_id, approval_fake());
    let hidden = thread_with_fake(&core, project_id, approval_fake());
    let (_, rx_focused) = core.subscribe_thread(focused).unwrap();
    let (_, rx_hidden) = core.subscribe_thread(hidden).unwrap();

    core.set_window_active(true);
    core.send_prompt(focused, "go").unwrap();
    wait_for_status(&rx_focused, ThreadStatus::NeedsInput);
    assert!(system.lines_starting("notify").is_empty());

    core.set_window_active(false);
    core.send_prompt(hidden, "go").unwrap();
    wait_for_status(&rx_hidden, ThreadStatus::NeedsInput);
    assert_eq!(
        system.lines_starting("notify"),
        [format!("notify {hidden} NeedsInput")]
    );

    core.interrupt_thread(hidden).unwrap();
    wait_for_status(&rx_hidden, ThreadStatus::Interrupted);
    assert_eq!(
        system.lines_starting("notify").len(),
        1,
        "interrupting is not worth a notification"
    );
}

#[test]
fn the_badge_counts_threads_in_needs_input() {
    let dir = tempdir().unwrap();
    let (core, project_id, system) = open_core(dir.path());
    let a = thread_with_fake(&core, project_id, approval_fake());
    let b = thread_with_fake(&core, project_id, approval_fake());
    let (_, rx_a) = core.subscribe_thread(a).unwrap();
    let (_, rx_b) = core.subscribe_thread(b).unwrap();

    core.send_prompt(a, "go").unwrap();
    wait_for_status(&rx_a, ThreadStatus::NeedsInput);
    core.send_prompt(b, "go").unwrap();
    wait_for_status(&rx_b, ThreadStatus::NeedsInput);
    assert_eq!(system.lines_starting("badge"), ["badge 1", "badge 2"]);

    core.interrupt_thread(a).unwrap();
    wait_for_status(&rx_a, ThreadStatus::Interrupted);
    assert_eq!(system.lines_starting("badge").last().unwrap(), "badge 1");
}

#[test]
fn quitting_asks_only_when_threads_are_active_and_the_setting_is_on() {
    let dir = tempdir().unwrap();
    let (core, project_id, _system) = open_core(dir.path());
    let id = thread_with_fake(&core, project_id, FakeProvider::default());
    let (_, rx) = core.subscribe_thread(id).unwrap();
    assert_eq!(core.quit_confirmation(), None, "nothing is running");

    core.send_prompt(id, "go").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);
    assert_eq!(core.quit_confirmation(), Some(1));

    core.disable_quit_confirmation().unwrap();
    assert!(!core.settings().settings.confirm_quit);
    assert_eq!(
        core.quit_confirmation(),
        None,
        "don't ask again is honoured"
    );
}

#[test]
fn quitting_interrupts_running_turns_and_stops_their_providers() {
    let dir = tempdir().unwrap();
    let (core, project_id, _system) = open_core(dir.path());
    let fake = FakeProvider::default();
    let recorder = fake.recorder();
    let id = thread_with_fake(&core, project_id, fake);
    let (_, rx) = core.subscribe_thread(id).unwrap();
    core.send_prompt(id, "go").unwrap();
    wait_for_status(&rx, ThreadStatus::Working);

    core.quit();

    assert_eq!(recorder.shutdowns(), 1);
    drop(core);
    let core = Core::open(dir.path()).unwrap();
    let snapshot = core.get_thread_snapshot(id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::Interrupted);
    assert_eq!(snapshot.turns[0].status, TurnStatus::Interrupted);
}

#[test]
fn relaunch_reopens_the_last_project_and_thread() {
    let dir = tempdir().unwrap();
    let (core, project_id, _system) = open_core(dir.path());
    assert_eq!(core.last_selection().unwrap(), None, "first launch");
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();

    core.remember_selection(project_id, Some(thread.id))
        .unwrap();
    drop(core);

    let core = Core::open(dir.path()).unwrap();
    assert_eq!(
        core.last_selection().unwrap(),
        Some(Selection {
            project_id,
            thread_id: Some(thread.id)
        })
    );
}

#[test]
fn a_remembered_selection_that_no_longer_exists_is_dropped() {
    let dir = tempdir().unwrap();
    let (core, project_id, _system) = open_core(dir.path());
    core.remember_selection(project_id, Some(999)).unwrap();
    assert_eq!(
        core.last_selection().unwrap(),
        Some(Selection {
            project_id,
            thread_id: None
        }),
        "an unknown Thread falls back to the Project alone"
    );
    core.remember_selection(999, None).unwrap();
    assert_eq!(core.last_selection().unwrap(), None);
}
