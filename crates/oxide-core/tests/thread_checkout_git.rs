//! Git operations resolve the checkout of the Thread they are given: a main checkout and two
//! Board worktrees on real temporary repositories, with a local bare remote.

use oxide_core::thread::ThreadStatus;
use oxide_core::{Core, DispatchRequest, PermissionMode, ProjectSummary, ThreadSummary};
use oxide_provider::{FakeProvider, ProviderEvent};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
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
    tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    work: PathBuf,
    remote: PathBuf,
    /// An ordinary Thread: it works in the main checkout.
    chat: ThreadSummary,
    /// Board Threads, each in a worktree of its own.
    one: ThreadSummary,
    two: ThreadSummary,
}

fn worktree(thread: &ThreadSummary) -> PathBuf {
    PathBuf::from(thread.worktree_path.clone().unwrap())
}

fn request(project_id: u32) -> DispatchRequest {
    DispatchRequest {
        project_id,
        prompt: "work".into(),
        provider: "fake".into(),
        model: None,
        effort: None,
        permission_mode: None,
        base_branch: Some("main".into()),
        issue_number: None,
        issue_title: None,
    }
}

/// Waits for the fake Provider's Turn to finish, so no Thread is working any more.
fn settle(core: &Core, thread_id: u32) {
    for _ in 0..500 {
        let snapshot = core.get_thread_snapshot(thread_id).unwrap();
        if snapshot.thread.status != ThreadStatus::Working && !snapshot.turns.is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("Thread {thread_id} never settled");
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let remote = root.join("remote.git");
    let work = root.join("scan").join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "first"]);
    git(
        &work,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&work, &["push", "-q", "-u", "origin", "main"]);

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project = core.add_project(&work.to_string_lossy()).unwrap();
    let chat = core
        .create_thread(project.id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    let one = core.dispatch_thread(request(project.id)).unwrap();
    let two = core.dispatch_thread(request(project.id)).unwrap();
    settle(&core, one.id);
    settle(&core, two.id);
    Fixture {
        tmp,
        core,
        project,
        work,
        remote,
        chat,
        one,
        two,
    }
}

#[test]
fn status_follows_the_thread_checkout_and_main_threads_share_state() {
    let f = fixture();
    let one = worktree(&f.one);
    std::fs::write(one.join("only-one.txt"), "x\n").unwrap();
    std::fs::write(f.work.join("main-only.txt"), "y\n").unwrap();

    let in_one = f.core.git_status_in(f.project.id, Some(f.one.id)).unwrap();
    let in_two = f.core.git_status_in(f.project.id, Some(f.two.id)).unwrap();
    let in_chat = f.core.git_status_in(f.project.id, Some(f.chat.id)).unwrap();
    let in_main = f.core.git_status_in(f.project.id, None).unwrap();

    assert_eq!(in_one.branch, f.one.branch);
    assert_eq!(in_two.branch, f.two.branch);
    assert_ne!(in_one.branch, in_two.branch);
    assert_eq!(in_one.changed_files, 1);
    assert_eq!(in_two.changed_files, 0);
    // An ordinary Thread shares the main checkout.
    assert_eq!(in_chat.branch.as_deref(), Some("main"));
    assert_eq!(in_chat.changed_files, 1);
    assert_eq!(in_chat.changed_files, in_main.changed_files);
}

#[test]
fn selected_file_commit_lands_in_that_worktree_and_keeps_unrelated_staged_state() {
    let f = fixture();
    let one = worktree(&f.one);
    std::fs::write(one.join("picked.txt"), "p\n").unwrap();
    std::fs::write(one.join("staged.txt"), "s\n").unwrap();
    git(&one, &["add", "staged.txt"]);
    std::fs::write(f.work.join("main-dirty.txt"), "m\n").unwrap();

    f.core
        .commit_in(f.project.id, Some(f.one.id), &["picked.txt".into()], "pick")
        .unwrap();

    assert_eq!(git(&one, &["log", "-1", "--format=%s"]).trim(), "pick");
    assert_eq!(
        git(&one, &["diff", "--cached", "--name-only"]).trim(),
        "staged.txt"
    );
    // The main checkout and the sibling worktree saw nothing.
    assert_eq!(git(&f.work, &["log", "-1", "--format=%s"]).trim(), "first");
    assert!(git(&f.work, &["status", "--porcelain"]).contains("main-dirty.txt"));
    assert_eq!(git(&worktree(&f.two), &["status", "--porcelain"]), "");
}

#[test]
fn branch_actions_and_push_target_the_thread_checkout() {
    let f = fixture();
    let one = worktree(&f.one);

    f.core
        .create_branch_in(f.project.id, Some(f.one.id), "topic")
        .unwrap();
    assert_eq!(git(&one, &["branch", "--show-current"]).trim(), "topic");
    assert_eq!(git(&f.work, &["branch", "--show-current"]).trim(), "main");
    assert_eq!(
        f.core
            .git_status_in(f.project.id, Some(f.two.id))
            .unwrap()
            .branch,
        f.two.branch
    );
    let listed = f
        .core
        .list_branches_in(f.project.id, Some(f.one.id))
        .unwrap();
    assert!(listed.iter().any(|b| b.name == "topic" && b.current));

    f.core.push_in(f.project.id, Some(f.one.id), false).unwrap();
    let branches = git(&f.remote, &["branch", "--format=%(refname:short)"]);
    assert!(branches.contains("topic"), "{branches}");
    assert!(!branches.contains(f.two.branch.as_deref().unwrap()));

    // Git's own refusal for a branch checked out elsewhere applies to the real target.
    let err = f
        .core
        .checkout_branch_in(f.project.id, Some(f.two.id), "main")
        .unwrap_err();
    assert!(err.to_string().contains("main"), "{err}");
}

#[test]
fn a_running_turn_only_blocks_branch_actions_in_its_own_checkout() {
    let f = fixture();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
    });
    f.core.register_fake_provider(f.chat.id, fake);
    f.core.send_prompt(f.chat.id, "go").unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let status = f.core.git_status_in(f.project.id, None).unwrap();
        if status.picker_disabled_reason.is_some() {
            break;
        }
        assert!(Instant::now() < deadline, "main checkout never guarded");
        std::thread::sleep(Duration::from_millis(20));
    }

    let blocked = f
        .core
        .create_branch_in(f.project.id, Some(f.chat.id), "blocked")
        .unwrap_err();
    assert!(blocked.to_string().contains("working"), "{blocked}");
    assert!(
        f.core
            .git_status_in(f.project.id, Some(f.two.id))
            .unwrap()
            .picker_disabled_reason
            .is_none()
    );
    f.core
        .create_branch_in(f.project.id, Some(f.one.id), "free")
        .unwrap();
}

#[test]
fn invalid_missing_and_stale_contexts_fail_without_falling_back_to_main() {
    let f = fixture();
    let other_dir = f.tmp.path().join("scan").join("other");
    std::fs::create_dir_all(&other_dir).unwrap();
    git(&other_dir, &["init", "-q", "-b", "main"]);
    std::fs::write(other_dir.join("x"), "x").unwrap();
    git(&other_dir, &["add", "x"]);
    git(&other_dir, &["commit", "-qm", "x"]);
    let other = f.core.add_project(&other_dir.to_string_lossy()).unwrap();

    // A Thread of another Project, and an unknown Thread.
    assert!(f.core.git_status_in(other.id, Some(f.one.id)).is_err());
    assert!(f.core.git_status_in(f.project.id, Some(9999)).is_err());
    assert!(
        f.core
            .commit_in(other.id, Some(f.one.id), &["a.txt".into()], "nope")
            .is_err()
    );

    // A deleted worktree directory.
    std::fs::remove_dir_all(worktree(&f.one)).unwrap();
    std::fs::write(f.work.join("main-dirty.txt"), "m\n").unwrap();
    let err = f
        .core
        .commit_in(
            f.project.id,
            Some(f.one.id),
            &["main-dirty.txt".into()],
            "stale",
        )
        .unwrap_err();
    assert!(err.to_string().contains("missing"), "{err}");
    assert!(f.core.git_status_in(f.project.id, Some(f.one.id)).is_err());
    assert!(f.core.push_in(f.project.id, Some(f.one.id), false).is_err());
    // Nothing leaked into the main checkout.
    assert_eq!(git(&f.work, &["log", "-1", "--format=%s"]).trim(), "first");
}
