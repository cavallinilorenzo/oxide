use oxide_core::{Core, FETCH_INTERVAL, PermissionMode, ProjectSummary};
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

fn commit_file(dir: &Path, name: &str, content: &str) {
    std::fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", name]);
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    /// The Project's checkout, cloned from `remote`.
    work: PathBuf,
    /// A second clone, for pushing changes the Project doesn't have yet.
    other: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let remote = root.join("remote.git");
    let scan = root.join("scan");
    std::fs::create_dir_all(&scan).unwrap();
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let other = root.join("other");
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["checkout", "-q", "-b", "main"]);
    commit_file(&other, "a.txt", "one\ntwo\nthree\n");
    git(&other, &["push", "-q", "-u", "origin", "main"]);
    let work = scan.join("work");
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().into_owned()];
    core.save_settings(&settings).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
    Fixture {
        _tmp: tmp,
        core,
        project,
        work,
        other,
    }
}

#[test]
fn creates_and_checks_out_branches_with_remote_ones_tracked() {
    let f = fixture();
    git(&f.other, &["checkout", "-q", "-b", "feature"]);
    commit_file(&f.other, "f.txt", "f\n");
    git(&f.other, &["push", "-q", "origin", "feature"]);
    f.core.fetch_project(f.project.id).unwrap();

    f.core.create_branch(f.project.id, "topic").unwrap();
    assert_eq!(
        f.core.git_status(f.project.id).unwrap().branch.as_deref(),
        Some("topic")
    );

    let branches = f.core.list_branches(f.project.id).unwrap();
    let find = |name: &str| branches.iter().find(|b| b.name == name).cloned();
    assert!(find("topic").unwrap().current);
    assert!(!find("main").unwrap().remote);
    assert!(find("origin/feature").unwrap().remote);
    assert!(find("origin/main").is_none(), "main already exists locally");
    assert!(find("origin/HEAD").is_none());

    f.core
        .checkout_branch(f.project.id, "origin/feature")
        .unwrap();
    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!(status.branch.as_deref(), Some("feature"));
    assert_eq!(status.upstream.as_deref(), Some("origin/feature"));
    assert!(f.work.join("f.txt").exists());

    f.core.checkout_branch(f.project.id, "main").unwrap();
    assert!(!f.work.join("f.txt").exists());
}

#[test]
fn rejects_option_like_and_invalid_branch_names() {
    let f = fixture();
    assert!(f.core.create_branch(f.project.id, "--orphan").is_err());
    assert!(f.core.create_branch(f.project.id, "bad name").is_err());
    assert!(f.core.checkout_branch(f.project.id, "nope").is_err());
}

#[test]
fn blocked_checkout_surfaces_gits_own_message() {
    let f = fixture();
    git(&f.work, &["checkout", "-q", "-b", "other"]);
    commit_file(&f.work, "a.txt", "changed on other\n");
    git(&f.work, &["checkout", "-q", "main"]);
    std::fs::write(f.work.join("a.txt"), "uncommitted\n").unwrap();

    let err = f.core.checkout_branch(f.project.id, "other").unwrap_err();

    assert!(
        err.to_string().contains("would be overwritten by checkout"),
        "{err}"
    );
    assert_eq!(
        f.core.git_status(f.project.id).unwrap().branch.as_deref(),
        Some("main")
    );
    assert_eq!(
        std::fs::read_to_string(f.work.join("a.txt")).unwrap(),
        "uncommitted\n",
        "no auto-stash"
    );
}

#[test]
fn chip_counts_match_git_diff_including_untracked_files() {
    let f = fixture();
    assert_eq!(f.core.git_status(f.project.id).unwrap().changed_files, 0);

    // a.txt: +2 −1; staged.txt: +2; untracked: +2 and +1 (binary counts 0).
    std::fs::write(f.work.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    std::fs::write(f.work.join("staged.txt"), "x\ny\n").unwrap();
    git(&f.work, &["add", "staged.txt"]);
    // Untracked: 2 lines, 1 unterminated line, and a binary file.
    std::fs::create_dir(f.work.join("dir")).unwrap();
    std::fs::write(f.work.join("dir/new.txt"), "p\nq\n").unwrap();
    std::fs::write(f.work.join("tail.txt"), "no newline").unwrap();
    std::fs::write(f.work.join("blob.bin"), [0u8, 1, 2, 3]).unwrap();

    let status = f.core.git_status(f.project.id).unwrap();

    git(&f.work, &["add", "-N", "."]);
    let numstat = git(&f.work, &["diff", "--numstat", "HEAD"]);
    let (mut added, mut removed) = (0, 0);
    for line in numstat.lines() {
        let mut cols = line.split('\t');
        added += cols.next().unwrap().parse::<u32>().unwrap_or(0);
        removed += cols.next().unwrap().parse::<u32>().unwrap_or(0);
    }
    assert_eq!((status.added, status.removed), (added, removed));
    assert_eq!((status.added, status.removed), (7, 1));
    assert_eq!(status.changed_files, 5);
}

#[test]
fn fetch_is_throttled_and_the_clock_is_injectable() {
    let f = fixture();
    let start = Instant::now();
    git(&f.other, &["checkout", "-q", "-b", "late"]);
    git(&f.other, &["push", "-q", "origin", "late"]);
    let remote_branches = |f: &Fixture| {
        f.core
            .list_branches(f.project.id)
            .unwrap()
            .iter()
            .any(|b| b.name == "origin/late")
    };

    assert!(f.core.fetch_project_at(f.project.id, start).unwrap());
    assert!(remote_branches(&f));

    git(&f.other, &["push", "-q", "origin", "late:later"]);
    let later_seen = |f: &Fixture| {
        f.core
            .list_branches(f.project.id)
            .unwrap()
            .iter()
            .any(|b| b.name == "origin/later")
    };
    let almost = start + FETCH_INTERVAL - Duration::from_secs(1);
    assert!(!f.core.fetch_project_at(f.project.id, almost).unwrap());
    assert!(!later_seen(&f));

    assert!(
        f.core
            .fetch_project_at(f.project.id, start + FETCH_INTERVAL)
            .unwrap()
    );
    assert!(later_seen(&f));
}

#[test]
fn pull_fast_forwards_when_behind_and_reports_failure_when_diverged() {
    let f = fixture();
    commit_file(&f.other, "b.txt", "b\n");
    git(&f.other, &["push", "-q"]);
    f.core.fetch_project(f.project.id).unwrap();
    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!((status.ahead, status.behind), (0, 1));

    f.core.pull(f.project.id).unwrap();

    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!((status.ahead, status.behind), (0, 0));
    assert!(f.work.join("b.txt").exists());

    // Diverge: one commit on each side.
    commit_file(&f.other, "c.txt", "c\n");
    git(&f.other, &["push", "-q"]);
    commit_file(&f.work, "d.txt", "d\n");
    f.core
        .fetch_project_at(f.project.id, Instant::now() + FETCH_INTERVAL)
        .unwrap();
    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!((status.ahead, status.behind), (1, 1));

    let err = f.core.pull(f.project.id).unwrap_err();

    assert!(err.to_string().contains("fast-forward"), "{err}");
    assert!(!f.work.join("c.txt").exists());
}

#[test]
fn picker_is_disabled_with_a_reason_while_a_thread_turn_is_working() {
    let f = fixture();
    assert_eq!(
        f.core
            .git_status(f.project.id)
            .unwrap()
            .picker_disabled_reason,
        None
    );

    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let _ = sender.send(ProviderEvent::TurnStarted {
            turn_index: 0,
            prompt: prompt.to_string(),
        });
    });
    let thread = f
        .core
        .create_thread(f.project.id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    f.core.register_fake_provider(thread.id, fake);
    f.core.send_prompt(thread.id, "go").unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    let reason = loop {
        if let Some(r) = f
            .core
            .git_status(f.project.id)
            .unwrap()
            .picker_disabled_reason
        {
            break r;
        }
        assert!(Instant::now() < deadline, "picker never disabled");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(reason.contains("Thread"), "{reason}");
    assert!(f.core.create_branch(f.project.id, "blocked").is_err());
    assert!(f.core.checkout_branch(f.project.id, "main").is_err());
}
