use oxide_core::{Core, PermissionMode};
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

#[test]
fn archived_thread_stays_listed_and_readable_flagged_archived() {
    let (_dir, core, project, thread) = core_with_thread();

    core.set_thread_archived(thread, true).unwrap();

    let list = core.list_threads(project).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].archived);
    assert!(core.get_thread_snapshot(thread).unwrap().thread.archived);
}

#[test]
fn thread_can_be_unarchived() {
    let (_dir, core, project, thread) = core_with_thread();
    core.set_thread_archived(thread, true).unwrap();

    core.set_thread_archived(thread, false).unwrap();

    assert!(!core.list_threads(project).unwrap()[0].archived);
}

#[test]
fn sending_a_prompt_unarchives_the_thread() {
    let (_dir, core, project, thread) = core_with_thread();
    core.set_thread_archived(thread, true).unwrap();

    core.send_prompt(thread, "hello").unwrap();

    assert!(!core.list_threads(project).unwrap()[0].archived);
}
