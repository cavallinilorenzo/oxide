use oxide_core::thread::ThreadStatus;
use oxide_core::{Core, DispatchRequest, ProjectSummary};
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
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().to_string()];
    core.save_settings(&settings).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
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
        std::fs::read_to_string(worktree.join("a.txt")).unwrap(),
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
        second
            .worktree_path
            .unwrap()
            .ends_with("my-project/same-task-2")
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
            Some("pwd; echo root=$OXIDE_PROJECT_ROOT; echo oops >&2; touch .setup-ran"),
        )
        .unwrap();

    let thread = f.core.dispatch_thread(request(&f, "Setup me")).unwrap();

    let worktree = PathBuf::from(thread.worktree_path.clone().unwrap());
    assert!(worktree.join(".setup-ran").exists());
    let output = thread.setup_output.clone().unwrap();
    let canonical = worktree.canonicalize().unwrap().display().to_string();
    assert!(output.contains(&canonical), "{output}");
    assert!(
        output.contains(&format!(
            "root={}",
            f.work.canonicalize().unwrap().display()
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
            Some("echo installing; echo broken >&2; exit 3"),
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
