use oxide_core::{Core, DeleteOutcome, PermissionMode};
use std::time::Duration;
use tempfile::tempdir;

fn core_with_thread() -> (tempfile::TempDir, Core, u32, u32) {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![dir.path().to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    std::fs::create_dir_all(dir.path().join("my-project/.git")).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
    let thread = core
        .create_thread(project.id, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    (dir, core, project.id, thread.id)
}

fn wait_for_completed_turn(core: &Core, thread: u32) {
    for _ in 0..500 {
        let snapshot = core.get_thread_snapshot(thread).unwrap();
        if snapshot
            .turns
            .first()
            .is_some_and(|t| t.status == oxide_core::TurnStatus::Completed)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("the Turn never completed");
}

#[test]
fn deleted_thread_leaves_the_list_and_cannot_be_read() {
    let (_dir, core, project, thread) = core_with_thread();

    let outcome = core.delete_thread(thread, false).unwrap();

    assert_eq!(outcome, DeleteOutcome::Deleted);
    assert!(core.list_threads(project).unwrap().is_empty());
    assert!(core.get_thread_snapshot(thread).is_err());
}

#[test]
fn deleting_a_thread_with_a_transcript_removes_it_and_leaves_other_threads_alone() {
    let (_dir, core, project, thread) = core_with_thread();
    let other = core
        .create_thread(project, "fake", None, None, PermissionMode::AutoEdit)
        .unwrap();
    core.send_prompt(thread, "hello").unwrap();
    core.send_prompt(other.id, "hi").unwrap();
    wait_for_completed_turn(&core, thread);
    wait_for_completed_turn(&core, other.id);

    core.delete_thread(thread, false).unwrap();

    assert!(core.get_thread_snapshot(thread).is_err());
    let kept = core.get_thread_snapshot(other.id).unwrap();
    assert_eq!(kept.turns.len(), 1);
    assert!(!kept.turns[0].items.is_empty());
}

#[test]
fn deleting_a_running_thread_stops_it() {
    let (_dir, core, project, thread) = core_with_thread();
    core.send_prompt(thread, "hello").unwrap();

    core.delete_thread(thread, false).unwrap();

    assert!(core.list_threads(project).unwrap().is_empty());
    assert_eq!(core.settings().errors.len(), 0);
}

#[test]
fn deleting_a_thread_twice_fails_the_second_time() {
    let (_dir, core, _project, thread) = core_with_thread();
    core.delete_thread(thread, false).unwrap();

    assert!(core.delete_thread(thread, false).is_err());
}
