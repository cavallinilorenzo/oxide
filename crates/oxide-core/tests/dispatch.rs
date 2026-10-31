use oxide_core::thread::ThreadStatus;
use oxide_core::{Core, DeleteOutcome, DispatchRequest, ProjectSummary};
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

/// The Thread's first Turn, which its actor creates a moment after dispatch returns.
fn first_turn(core: &Core, thread_id: u32) -> oxide_core::TurnSnapshot {
    for _ in 0..500 {
        if let Some(turn) = core.get_thread_snapshot(thread_id).unwrap().turns.first() {
            return turn.clone();
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("the Thread never started a Turn");
}

fn completed_first_turn(core: &Core, thread_id: u32) -> oxide_core::TurnSnapshot {
    for _ in 0..500 {
        if let Some(turn) = core
            .get_thread_snapshot(thread_id)
            .unwrap()
            .turns
            .first()
            .filter(|turn| turn.status == oxide_core::TurnStatus::Completed)
        {
            return turn.clone();
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("the Thread's first Turn never completed");
}

fn request(f: &Fixture, prompt: &str) -> DispatchRequest {
    DispatchRequest {
        project_id: f.project.id,
        prompt: prompt.into(),
        provider: "fake".into(),
        model: None,
        effort: None,
        permission_mode: None,
        base_branch: Some("main".into()),
        issue_number: None,
        issue_title: None,
    }
}

#[test]
fn dispatch_creates_a_worktree_on_an_oxide_branch_from_the_base_branch() {
    let f = fixture();
    // Uncommitted changes in the main checkout are not carried over.
    std::fs::write(f.work.join("a.txt"), "dirty\n").unwrap();
    std::fs::write(f.work.join("untracked.txt"), "x").unwrap();

    let thread = f
        .core
        .dispatch_thread(request(&f, "Fix the login bug"))
        .unwrap();

    assert_eq!(thread.branch.as_deref(), Some("oxide/fix-the-login-bug"));
    let worktree = PathBuf::from(thread.worktree_path.clone().unwrap());
    assert_eq!(
        worktree,
        f.home
            .join("worktrees")
            .join("my-project")
            .join("fix-the-login-bug")
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("a.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "committed\n"
    );
    assert!(!worktree.join("untracked.txt").exists());
    assert_eq!(
        git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "oxide/fix-the-login-bug"
    );
    assert_eq!(
        git(&worktree, &["rev-parse", "HEAD"]),
        git(&f.work, &["rev-parse", "main"])
    );
}

#[test]
fn dispatch_starts_from_the_chosen_base_branch() {
    let f = fixture();
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(f.work.join("b.txt"), "on feature\n").unwrap();
    git(&f.work, &["add", "b.txt"]);
    git(&f.work, &["commit", "-qm", "feature"]);
    git(&f.work, &["checkout", "-q", "main"]);

    let mut req = request(&f, "From feature");
    req.base_branch = Some("feature".into());
    let thread = f.core.dispatch_thread(req).unwrap();

    let worktree = PathBuf::from(thread.worktree_path.unwrap());
    assert!(worktree.join("b.txt").exists());
}

#[test]
fn a_name_collision_gets_a_suffix() {
    let f = fixture();
    let first = f.core.dispatch_thread(request(&f, "Same task")).unwrap();
    let second = f.core.dispatch_thread(request(&f, "Same task")).unwrap();
    let third = f.core.dispatch_thread(request(&f, "Same task")).unwrap();

    assert_eq!(first.branch.as_deref(), Some("oxide/same-task"));
    assert_eq!(second.branch.as_deref(), Some("oxide/same-task-2"));
    assert_eq!(third.branch.as_deref(), Some("oxide/same-task-3"));
    assert!(
        Path::new(&second.worktree_path.unwrap())
            .ends_with(Path::new("my-project").join("same-task-2"))
    );
}

#[test]
fn the_dispatched_thread_runs_its_first_turn() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Do it")).unwrap();

    assert_eq!(first_turn(&f.core, thread.id).prompt, "Do it");
    let listed = f.core.list_threads(f.project.id).unwrap();
    let listed = listed.iter().find(|t| t.id == thread.id).unwrap();
    assert_eq!(listed.branch.as_deref(), Some("oxide/do-it"));
}

#[test]
fn the_setup_command_runs_in_the_worktree_with_the_project_root_and_its_output_is_kept() {
    let f = fixture();
    f.core
        .set_project_setup_command(
            f.project.id,
            Some(if cfg!(windows) {
                "cd & echo root=%OXIDE_PROJECT_ROOT% & echo oops 1>&2 & type nul > .setup-ran"
            } else {
                "pwd; echo root=$OXIDE_PROJECT_ROOT; echo oops >&2; touch .setup-ran"
            }),
        )
        .unwrap();

    let thread = f.core.dispatch_thread(request(&f, "Setup me")).unwrap();

    let worktree = PathBuf::from(thread.worktree_path.clone().unwrap());
    assert!(worktree.join(".setup-ran").exists());
    let output = thread.setup_output.clone().unwrap().replace("\\\\?\\", "");
    // `cmd.exe` may print an 8.3 short path for the current directory on CI,
    // so compare the worktree's stable leaf instead of its full canonical path.
    let worktree_name = worktree.file_name().unwrap().to_string_lossy();
    assert!(output.contains(worktree_name.as_ref()), "{output}");
    assert!(
        output.contains(&format!(
            "root={}",
            f.work
                .canonicalize()
                .unwrap()
                .display()
                .to_string()
                .replace("\\\\?\\", "")
        )),
        "{output}"
    );
    assert!(output.contains("oops"), "{output}");
    assert_eq!(first_turn(&f.core, thread.id).prompt, "Setup me");
}

#[test]
fn a_failing_setup_command_leaves_the_thread_in_needs_input_without_a_turn() {
    let f = fixture();
    f.core
        .set_project_setup_command(
            f.project.id,
            Some(if cfg!(windows) {
                "echo installing & echo broken 1>&2 & exit /b 3"
            } else {
                "echo installing; echo broken >&2; exit 3"
            }),
        )
        .unwrap();

    let thread = f.core.dispatch_thread(request(&f, "Setup fails")).unwrap();

    assert_eq!(thread.status, ThreadStatus::NeedsInput);
    let output = thread.setup_output.unwrap();
    assert!(
        output.contains("installing") && output.contains("broken"),
        "{output}"
    );
    let snapshot = f.core.get_thread_snapshot(thread.id).unwrap();
    assert_eq!(snapshot.turn_count, 0);
    assert_eq!(snapshot.thread.status, ThreadStatus::NeedsInput);
    assert!(PathBuf::from(snapshot.thread.worktree_path.unwrap()).exists());
}

#[test]
fn the_setup_command_is_stored_by_oxide_and_never_written_into_the_repository() {
    let f = fixture();
    assert_eq!(f.core.project_setup_command(f.project.id).unwrap(), None);

    f.core
        .set_project_setup_command(f.project.id, Some("npm install"))
        .unwrap();
    assert_eq!(
        f.core
            .project_setup_command(f.project.id)
            .unwrap()
            .as_deref(),
        Some("npm install")
    );
    assert_eq!(git(&f.work, &["status", "--porcelain"]), "");

    f.core
        .set_project_setup_command(f.project.id, Some("  "))
        .unwrap();
    assert_eq!(f.core.project_setup_command(f.project.id).unwrap(), None);
}

#[test]
fn a_board_thread_does_not_block_branch_switching_in_the_main_checkout() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Long task")).unwrap();
    assert!(thread.worktree_path.is_some());
    git(&f.work, &["branch", "other"]);
    f.core.checkout_branch(f.project.id, "other").unwrap();
}

#[test]
fn a_thread_started_from_an_issue_remembers_it_and_branches_on_its_number() {
    let f = fixture();
    let mut req = request(&f, "Fix it\n\nIssue #51");
    req.issue_number = Some(51);
    req.issue_title = Some("Start a Thread from an issue".into());
    let thread = f.core.dispatch_thread(req).unwrap();

    assert_eq!(thread.issue_number, Some(51));
    assert_eq!(
        thread.branch.as_deref(),
        Some("oxide/51-start-a-thread-from-an-issue")
    );
    let plain = f.core.dispatch_thread(request(&f, "No issue")).unwrap();
    assert_eq!(plain.issue_number, None);
}

fn worktree_of(thread: &oxide_core::ThreadSummary) -> PathBuf {
    PathBuf::from(thread.worktree_path.clone().unwrap())
}

#[test]
fn deleting_a_clean_board_thread_removes_its_worktree_and_checkpoints_and_keeps_the_branch() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Clean up")).unwrap();
    let worktree = worktree_of(&thread);
    completed_first_turn(&f.core, thread.id);
    let checkpoints = format!("refs/oxide/checkpoints/{}/", thread.id);
    assert!(!git(&f.work, &["for-each-ref", &checkpoints]).is_empty());

    let outcome = f.core.delete_thread(thread.id, false).unwrap();

    assert_eq!(outcome, DeleteOutcome::Deleted);
    assert!(!worktree.exists());
    git(&f.work, &["rev-parse", "--verify", "oxide/clean-up"]);
    assert!(git(&f.work, &["for-each-ref", &checkpoints]).is_empty());
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn deleting_a_board_thread_preserves_unsaved_buffers_and_stops_editor_processes_after_save() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Editor work")).unwrap();
    completed_first_turn(&f.core, thread.id);
    let key = format!("{}:{}", f.project.id, thread.id);
    f.core.set_editor_dirty(key.clone(), true);
    assert!(
        f.core
            .delete_thread(thread.id, true)
            .unwrap_err()
            .to_string()
            .contains("unsaved editor")
    );
    assert!(worktree_of(&thread).exists());
    f.core.set_editor_dirty(key, false);
    f.core
        .configure_language_server(
            "python",
            oxide_core::LanguageServerConfig {
                command: "python".into(),
                args: vec![
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("fixtures/lsp.py")
                        .to_string_lossy()
                        .into_owned(),
                ],
                interpreter: None,
            },
        )
        .unwrap();
    let (server, _messages) = f
        .core
        .start_language_server(f.project.id, Some(thread.id), "python")
        .unwrap();
    let terminal = f
        .core
        .start_block_terminal(f.project.id, Some(thread.id))
        .unwrap();
    assert_eq!(
        f.core.delete_thread(thread.id, false).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(!worktree_of(&thread).exists());
    assert!(f.core.write_terminal(terminal.id, b"echo gone\n").is_err());
    assert!(f.core.language_server_message(server.id, "{}").is_err());
}

#[test]
fn deleting_a_dirty_board_thread_asks_first_and_declining_keeps_everything() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Dirty work")).unwrap();
    let worktree = worktree_of(&thread);
    completed_first_turn(&f.core, thread.id);
    std::fs::write(worktree.join("wip.txt"), "unsaved").unwrap();

    let outcome = f.core.delete_thread(thread.id, false).unwrap();

    assert_eq!(outcome, DeleteOutcome::NeedsConfirmation);
    assert!(worktree.join("wip.txt").exists());
    assert_eq!(f.core.list_threads(f.project.id).unwrap().len(), 1);
    assert!(f.core.get_thread_snapshot(thread.id).is_ok());

    // Accepting removes the worktree and the Thread; the branch survives.
    assert_eq!(
        f.core.delete_thread(thread.id, true).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(!worktree.exists());
    git(&f.work, &["rev-parse", "--verify", "oxide/dirty-work"]);
    assert!(f.core.list_threads(f.project.id).unwrap().is_empty());
}

#[test]
fn deleting_a_board_thread_closes_only_its_own_terminals_and_declining_keeps_them() {
    let f = fixture();
    let doomed = f.core.dispatch_thread(request(&f, "Doomed")).unwrap();
    let sibling = f.core.dispatch_thread(request(&f, "Sibling")).unwrap();
    completed_first_turn(&f.core, doomed.id);
    completed_first_turn(&f.core, sibling.id);

    // Each shell keeps the checkout it was started in.
    let in_doomed = f
        .core
        .start_block_terminal(f.project.id, Some(doomed.id))
        .unwrap();
    let in_sibling = f
        .core
        .start_block_terminal(f.project.id, Some(sibling.id))
        .unwrap();
    let in_main = f.core.start_block_terminal(f.project.id, None).unwrap();
    assert!(Path::new(&in_doomed.cwd).starts_with(worktree_of(&doomed)));
    assert!(Path::new(&in_sibling.cwd).starts_with(worktree_of(&sibling)));
    assert!(!Path::new(&in_main.cwd).starts_with(worktree_of(&doomed)));

    // Declining the dirty-worktree confirmation leaves the worktree and every shell alive.
    std::fs::write(worktree_of(&doomed).join("wip.txt"), "unsaved").unwrap();
    assert_eq!(
        f.core.delete_thread(doomed.id, false).unwrap(),
        DeleteOutcome::NeedsConfirmation
    );
    assert!(worktree_of(&doomed).exists());
    assert!(f.core.write_terminal(in_doomed.id, b"true\n").is_ok());

    // Confirming closes the worktree's shells; siblings and the main checkout's shell survive.
    assert_eq!(
        f.core.delete_thread(doomed.id, true).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(!worktree_of(&doomed).exists());
    assert!(f.core.write_terminal(in_doomed.id, b"true\n").is_err());
    assert!(f.core.write_terminal(in_sibling.id, b"true\n").is_ok());
    assert!(f.core.write_terminal(in_main.id, b"true\n").is_ok());
    git(&f.work, &["rev-parse", "--verify", "oxide/doomed"]);

    // Explicit close closes exactly that session.
    f.core.close_terminal(in_sibling.id).unwrap();
    assert!(f.core.write_terminal(in_sibling.id, b"true\n").is_err());
    assert!(f.core.write_terminal(in_main.id, b"true\n").is_ok());
    f.core.close_terminal(in_main.id).unwrap();
}

#[test]
fn a_worktree_deleted_by_hand_is_recreated_on_the_next_message() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Come back")).unwrap();
    let worktree = worktree_of(&thread);
    completed_first_turn(&f.core, thread.id);
    std::fs::remove_dir_all(&worktree).unwrap();

    f.core.send_prompt(thread.id, "Again").unwrap();

    assert!(worktree.join("a.txt").exists());
    assert_eq!(
        git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
        "oxide/come-back"
    );
}

#[test]
fn opening_a_project_prunes_worktrees_deleted_by_hand() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Stale")).unwrap();
    std::fs::remove_dir_all(worktree_of(&thread)).unwrap();
    assert!(git(&f.work, &["worktree", "list"]).contains("stale"));

    f.core.open_project(f.project.id).unwrap();

    assert!(!git(&f.work, &["worktree", "list"]).contains("stale"));
}

fn read(path: PathBuf) -> String {
    std::fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

#[test]
fn file_writes_stay_in_their_checkout_and_a_deleted_worktree_never_falls_back_to_main() {
    let f = fixture();
    let thread = f.core.dispatch_thread(request(&f, "Edit files")).unwrap();
    let worktree = PathBuf::from(thread.worktree_path.clone().unwrap());
    let (project, id) = (f.project.id, thread.id);

    // The same relative path is two documents: a write in the worktree leaves main alone.
    // Line endings depend on the platform's checkout, so the buffer is what Core reads.
    let opened = f
        .core
        .read_file(project, Some(id), "a.txt")
        .unwrap()
        .content;
    f.core
        .write_file(project, Some(id), "a.txt", &opened, "worktree edit\n")
        .unwrap();
    assert_eq!(read(worktree.join("a.txt")), "worktree edit\n");
    assert_eq!(read(f.work.join("a.txt")), "committed\n");

    // Once the Thread and its worktree are gone its context is stale: writes are refused
    // and the main checkout keeps its content.
    assert_eq!(
        f.core.delete_thread(id, true).unwrap(),
        DeleteOutcome::Deleted
    );
    assert!(
        f.core
            .write_file(project, Some(id), "a.txt", &opened, "stale write\n")
            .is_err()
    );
    assert!(f.core.create_file(project, Some(id), "new.txt").is_err());
    assert!(!f.work.join("new.txt").exists());
    assert_eq!(read(f.work.join("a.txt")), "committed\n");
}
