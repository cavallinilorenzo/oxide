use oxide_core::{Core, DeleteOutcome, ProjectSummary, ThreadStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    work: PathBuf,
    home: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("oxide-home");
    let scan = tmp.path().join("scan");
    let work = scan.join("my-project");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "committed\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    let core = Core::open(&home).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project,
        work,
        home,
    }
}

/// The Thread's first Turn, which its actor creates a moment after the prompt is sent.
fn first_turn(core: &Core, thread_id: u32) -> oxide_core::TurnSnapshot {
    for _ in 0..500 {
        if let Some(turn) = core.get_thread_snapshot(thread_id).unwrap().turns.first() {
            return turn.clone();
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("the Thread never started a Turn");
}

fn chat_thread(core: &Core, project_id: u32) -> oxide_core::ThreadSummary {
    core.create_thread(project_id, "fake", None, None, None)
        .unwrap()
}

#[test]
fn new_projects_default_to_giving_chat_threads_their_own_worktree() {
    let f = fixture();
    assert!(
        !f.core
            .project_threads_in_main_checkout(f.project.id)
            .unwrap()
    );
}

#[test]
fn threads_in_main_checkout_can_be_read_and_written() {
    let f = fixture();
    f.core
        .set_project_threads_in_main_checkout(f.project.id, true)
        .unwrap();
    assert!(
        f.core
            .project_threads_in_main_checkout(f.project.id)
            .unwrap()
    );
    f.core
        .set_project_threads_in_main_checkout(f.project.id, false)
        .unwrap();
    assert!(
        !f.core
            .project_threads_in_main_checkout(f.project.id)
            .unwrap()
    );
}

#[test]
fn setting_threads_in_main_checkout_on_an_unknown_project_fails() {
    let f = fixture();
    assert!(
        f.core
            .set_project_threads_in_main_checkout(99999, true)
            .is_err()
    );
}

#[test]
fn chat_thread_creates_its_worktree_on_its_first_prompt() {
    let f = fixture();
    // Uncommitted changes in the main checkout stay behind: they are not carried over.
    std::fs::write(f.work.join("a.txt"), "dirty\n").unwrap();
    std::fs::write(f.work.join("untracked.txt"), "x").unwrap();

    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Fix the login bug").unwrap();
    let turn = first_turn(&f.core, thread.id);
    assert_eq!(turn.prompt, "Fix the login bug");

    let listed = f.core.list_threads(f.project.id).unwrap();
    let listed = listed.iter().find(|t| t.id == thread.id).unwrap();
    assert!(listed.worktree_path.is_some());
    let worktree = PathBuf::from(listed.worktree_path.clone().unwrap());
    assert_eq!(
        worktree,
        f.home
            .join("worktrees")
            .join("my-project")
            .join(format!("thread-{}", thread.id))
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "committed\n"
    );
    assert!(!worktree.join("untracked.txt").exists());
    assert!(
        git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
            .trim()
            .starts_with("oxide/")
    );
}

#[test]
fn chat_thread_runs_the_setup_command_in_its_worktree() {
    let f = fixture();
    f.core
        .set_project_setup_command(
            f.project.id,
            Some(if cfg!(windows) {
                "cd & echo root=%OXIDE_PROJECT_ROOT% & type nul > .setup-ran"
            } else {
                "pwd; echo root=$OXIDE_PROJECT_ROOT; touch .setup-ran"
            }),
        )
        .unwrap();

    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Set up").unwrap();
    first_turn(&f.core, thread.id);

    let listed = f.core.list_threads(f.project.id).unwrap();
    let thread_summary = listed.iter().find(|t| t.id == thread.id).unwrap();
    let worktree = PathBuf::from(thread_summary.worktree_path.clone().unwrap());
    assert!(worktree.join(".setup-ran").exists());
    let output = thread_summary.setup_output.clone().unwrap();
    assert!(
        output.contains("root="),
        "setup output should echo the project root: {output}"
    );
}

#[test]
fn a_failing_setup_command_leaves_a_chat_thread_in_needs_input_without_a_turn() {
    let f = fixture();
    f.core
        .set_project_setup_command(
            f.project.id,
            Some(if cfg!(windows) {
                "echo broken >&2 & exit /b 3"
            } else {
                "echo broken >&2; exit 3"
            }),
        )
        .unwrap();

    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Setup fails").unwrap();

    let snapshot = f.core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.thread.status, ThreadStatus::NeedsInput);
    assert_eq!(snapshot.turn_count, 0);
    assert!(snapshot.thread.worktree_path.is_some());
}

#[test]
fn chat_thread_stays_in_the_main_checkout_when_the_project_opts_out() {
    let f = fixture();
    f.core
        .set_project_threads_in_main_checkout(f.project.id, true)
        .unwrap();

    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Stay put").unwrap();
    first_turn(&f.core, thread.id);

    let listed = f.core.list_threads(f.project.id).unwrap();
    let listed = listed.iter().find(|t| t.id == thread.id).unwrap();
    assert!(listed.worktree_path.is_none());
}

#[test]
fn chat_thread_in_a_folder_that_is_not_a_git_checkout_keeps_working_in_main() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("oxide-home");
    let work = tmp.path().join("not-a-repo");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("a.txt"), "committed\n").unwrap();
    let core = Core::open(&home).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();

    let thread = core
        .create_thread(project.id, "fake", None, None, None)
        .unwrap();
    core.send_prompt(thread.id, "No git here").unwrap();
    first_turn(&core, thread.id);

    let listed = core.list_threads(project.id).unwrap();
    let listed = listed.iter().find(|t| t.id == thread.id).unwrap();
    assert!(listed.worktree_path.is_none());
}

#[test]
fn deleting_a_clean_chat_thread_removes_its_worktree() {
    let f = fixture();
    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Clean up").unwrap();
    first_turn(&f.core, thread.id);
    let worktree = PathBuf::from(
        f.core
            .list_threads(f.project.id)
            .unwrap()
            .iter()
            .find(|t| t.id == thread.id)
            .unwrap()
            .worktree_path
            .clone()
            .unwrap(),
    );

    assert_eq!(
        f.core.delete_thread(thread.id, false).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(!worktree.exists());
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn deleting_a_dirty_chat_thread_asks_first_and_declining_keeps_everything() {
    let f = fixture();
    let thread = chat_thread(&f.core, f.project.id);
    f.core.send_prompt(thread.id, "Dirty work").unwrap();
    first_turn(&f.core, thread.id);
    let worktree = PathBuf::from(
        f.core
            .list_threads(f.project.id)
            .unwrap()
            .iter()
            .find(|t| t.id == thread.id)
            .unwrap()
            .worktree_path
            .clone()
            .unwrap(),
    );
    std::fs::write(worktree.join("wip.txt"), "unsaved").unwrap();

    let outcome = f.core.delete_thread(thread.id, false).unwrap();
    assert_eq!(outcome, DeleteOutcome::NeedsConfirmation);
    assert!(worktree.join("wip.txt").exists());
    assert_eq!(f.core.list_threads(f.project.id).unwrap().len(), 1);

    assert_eq!(
        f.core.delete_thread(thread.id, true).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(!worktree.exists());
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}
