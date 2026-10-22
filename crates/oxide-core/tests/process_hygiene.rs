use crossbeam_channel::Receiver;
use oxide_core::{
    Core, ManualClock, PROVIDER_IDLE_TIMEOUT, PermissionMode, SequencedThreadEvent, ThreadEvent,
    ThreadStatus,
};
use oxide_provider::FakeProvider;
use oxide_provider::process::{ProcessRegistry, group_alive, spawn_in_own_group};
use rusqlite::Connection;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;

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

fn sleeper() -> std::process::Child {
    let mut cmd = Command::new("sleep");
    cmd.arg("300").stdout(Stdio::null()).stderr(Stdio::null());
    spawn_in_own_group(&mut cmd).spawn().unwrap()
}

fn wait_group_gone(child: &mut std::process::Child) -> bool {
    let pgid = child.id() as i32;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let _ = child.try_wait();
        if !group_alive(pgid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn an_idle_thread_gives_up_its_provider_after_ten_minutes_and_resumes_lazily() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let clock = Arc::new(ManualClock::new());
    core.set_clock(clock.clone());
    let fake = FakeProvider::scripted();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();
    assert_eq!(
        recorder.starts(),
        0,
        "nothing starts before the first prompt"
    );

    core.send_prompt(thread.id, "first").unwrap();
    core.tick_thread(thread.id);
    wait_for_status(&rx, ThreadStatus::Completed);
    assert_eq!(recorder.starts(), 1);
    // The Provider reported its session id during that Turn.
    Connection::open(dir.path().join("oxide.db"))
        .unwrap()
        .execute(
            "UPDATE threads SET provider_session_id = 'sess-1' WHERE id = ?1",
            [thread.id],
        )
        .unwrap();

    clock.advance(PROVIDER_IDLE_TIMEOUT - Duration::from_secs(1));
    core.tick_thread(thread.id);
    core.subscribe_thread(thread.id).unwrap(); // round trip: the tick has been handled
    assert_eq!(recorder.shutdowns(), 0, "not yet idle for 10 minutes");

    clock.advance(Duration::from_secs(1));
    core.tick_thread(thread.id);
    core.subscribe_thread(thread.id).unwrap();
    assert_eq!(recorder.shutdowns(), 1, "reaped after 10 idle minutes");
    assert_eq!(
        core.get_thread_snapshot(thread.id).unwrap().thread.status,
        ThreadStatus::Completed,
        "reaping is invisible to the Thread"
    );

    core.send_prompt(thread.id, "second").unwrap();
    core.tick_thread(thread.id);
    wait_for_status(&rx, ThreadStatus::Completed);
    assert_eq!(recorder.starts(), 2);
    assert_eq!(recorder.resumes(), vec!["sess-1"]);
    assert_eq!(recorder.prompts(), vec!["first", "second"]);
    assert_eq!(core.get_thread_snapshot(thread.id).unwrap().turns.len(), 2);
}

#[test]
fn a_thread_with_a_turn_in_flight_is_never_reaped() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let clock = Arc::new(ManualClock::new());
    core.set_clock(clock.clone());
    let fake = FakeProvider::default();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();

    // The default Fake starts a Turn and leaves it running.
    core.send_prompt(thread.id, "long job").unwrap();
    core.tick_thread(thread.id);
    wait_for_status(&rx, ThreadStatus::Working);
    clock.advance(PROVIDER_IDLE_TIMEOUT * 3);
    core.tick_thread(thread.id);
    core.subscribe_thread(thread.id).unwrap();

    assert_eq!(recorder.shutdowns(), 0);
}

#[test]
fn shutting_core_down_shuts_every_provider_down() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let fake = FakeProvider::scripted();
    let recorder = fake.recorder();
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.register_fake_provider(thread.id, fake);
    let (_, rx) = core.subscribe_thread(thread.id).unwrap();
    core.send_prompt(thread.id, "hello").unwrap();
    core.tick_thread(thread.id);
    wait_for_status(&rx, ThreadStatus::Completed);

    core.shutdown();

    assert_eq!(recorder.shutdowns(), 1);
}

#[test]
fn relaunch_turns_working_and_needs_input_into_interrupted_and_starts_nothing() {
    let dir = tempdir().unwrap();
    let (core, project_id) = open_core_with_project(dir.path());
    let working = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    let waiting = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    let done = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    drop(core);
    // What a crashed run leaves behind: two Turns in flight and an unanswered Approval.
    let conn = Connection::open(dir.path().join("oxide.db")).unwrap();
    conn.execute_batch(&format!(
        "UPDATE threads SET status = 'working' WHERE id = {working};
         UPDATE threads SET status = 'needs-input' WHERE id = {waiting};
         INSERT INTO turns (id, thread_id, turn_index, prompt, status) VALUES
            (1, {working}, 0, 'a', 'running'), (2, {waiting}, 0, 'b', 'running');
         INSERT INTO approvals (turn_id, approval_id, kind, summary) VALUES (2, 'ap-1', 'command', 'rm');",
        working = working.id,
        waiting = waiting.id,
    ))
    .unwrap();
    drop(conn);

    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let fake = FakeProvider::scripted();
    let recorder = fake.recorder();
    core.register_fake_provider(working.id, fake);
    let (snapshot, _rx) = core.subscribe_thread(working.id).unwrap();

    assert_eq!(snapshot.thread.status, ThreadStatus::Interrupted);
    let status_of = |id| core.get_thread_snapshot(id).unwrap().thread.status;
    assert_eq!(status_of(waiting.id), ThreadStatus::Interrupted);
    assert_eq!(status_of(done.id), ThreadStatus::Completed);
    let waiting_turn = &core.get_thread_snapshot(waiting.id).unwrap().turns[0];
    assert_eq!(waiting_turn.status, oxide_core::TurnStatus::Interrupted);
    assert!(
        waiting_turn.approvals[0].decision.is_some(),
        "the unanswered Approval is closed"
    );
    assert_eq!(recorder.starts(), 0, "nothing restarts automatically");
}

#[test]
fn next_launch_kills_stale_groups_whose_leader_matches() {
    let dir = tempdir().unwrap();
    let mut orphan = sleeper();
    // A crashed run recorded the group and never got to unregister it.
    ProcessRegistry::open(dir.path().join("processes.json")).register(orphan.id() as i32, "sleep");

    let _core = Core::open(dir.path()).unwrap();

    assert!(
        wait_group_gone(&mut orphan),
        "the orphan survived the relaunch"
    );
}

#[test]
fn next_launch_leaves_a_reused_pid_alone() {
    let dir = tempdir().unwrap();
    let mut bystander = sleeper();
    let pgid = bystander.id() as i32;
    // The recorded executable is not what now runs under that pid.
    ProcessRegistry::open(dir.path().join("processes.json")).register(pgid, "claude");

    let _core = Core::open(dir.path()).unwrap();

    assert!(group_alive(pgid), "an unrelated process must not be killed");
    unsafe { libc::kill(-pgid, libc::SIGKILL) };
    assert!(wait_group_gone(&mut bystander));
}
