use oxide_core::{Core, FETCH_INTERVAL, ProjectSummary};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
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
    /// The bare remote both clones push to.
    remote: PathBuf,
    /// The Project's checkout.
    work: PathBuf,
    /// A second clone, for changes made behind the Project's back.
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
    // Oxide runs git as the user, whose identity is configured.
    git(&work, &["config", "user.name", "T"]);
    git(&work, &["config", "user.email", "t@example.com"]);

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
        remote,
        work,
        other,
    }
}

fn paths(p: &[&str]) -> Vec<String> {
    p.iter().map(|s| s.to_string()).collect()
}

#[test]
fn commit_includes_exactly_the_checked_files_and_keeps_other_staged_state() {
    let f = fixture();
    std::fs::write(f.work.join("a.txt"), "one\nTWO\nthree\n").unwrap(); // modified, picked
    std::fs::write(f.work.join("new.txt"), "new\n").unwrap(); // untracked, picked
    std::fs::write(f.work.join("skipped.txt"), "skip\n").unwrap(); // untracked, not picked
    std::fs::write(f.work.join("staged.txt"), "staged\n").unwrap(); // staged, not picked
    git(&f.work, &["add", "staged.txt"]);

    f.core
        .commit(f.project.id, &paths(&["a.txt", "new.txt"]), "Pick two")
        .unwrap();

    let committed = git(&f.work, &["show", "--name-only", "--format=%s", "HEAD"]);
    let mut lines: Vec<_> = committed.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.remove(0), "Pick two");
    lines.sort();
    assert_eq!(lines, ["a.txt", "new.txt"]);
    assert_eq!(
        git(&f.work, &["diff", "--cached", "--name-only"]).trim(),
        "staged.txt"
    );
    assert_eq!(
        git(&f.work, &["ls-files", "--others", "--exclude-standard"]).trim(),
        "skipped.txt"
    );
}

#[test]
fn commit_handles_deletions_and_renames_and_rejects_bad_input() {
    let f = fixture();
    commit_file(&f.work, "gone.txt", "bye\n");
    std::fs::remove_file(f.work.join("gone.txt")).unwrap();
    git(&f.work, &["mv", "a.txt", "b.txt"]);

    f.core
        .commit(
            f.project.id,
            &paths(&["gone.txt", "a.txt", "b.txt"]),
            "Tidy",
        )
        .unwrap();

    assert!(git(&f.work, &["status", "--porcelain"]).trim().is_empty());
    assert!(f.core.commit(f.project.id, &[], "msg").is_err());
    assert!(
        f.core
            .commit(f.project.id, &paths(&["b.txt"]), "  ")
            .is_err()
    );
}

#[test]
fn push_sets_upstream_on_first_push_and_publishes_commits() {
    let f = fixture();
    f.core.create_branch(f.project.id, "topic").unwrap();
    commit_file(&f.work, "t.txt", "t\n");
    let status = f.core.git_status(f.project.id).unwrap();
    assert!(status.upstream.is_none() && status.unpublished);

    f.core.push(f.project.id, false).unwrap();

    assert!(git(&f.remote, &["branch", "--format=%(refname:short)"]).contains("topic"));
    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!(status.upstream.as_deref(), Some("origin/topic"));
    assert!(!status.unpublished);

    commit_file(&f.work, "u.txt", "u\n");
    assert_eq!(f.core.git_status(f.project.id).unwrap().ahead, 1);
    f.core.push(f.project.id, false).unwrap();
    assert_eq!(f.core.git_status(f.project.id).unwrap().ahead, 0);
}

#[test]
fn push_on_main_needs_explicit_consent() {
    let f = fixture();
    commit_file(&f.work, "m.txt", "m\n");
    assert!(f.core.git_status(f.project.id).unwrap().protected);

    let err = f.core.push(f.project.id, false).unwrap_err();
    assert!(err.to_string().contains("main"), "{err}");
    assert_eq!(f.core.git_status(f.project.id).unwrap().ahead, 1);

    f.core.push(f.project.id, true).unwrap();
    assert_eq!(f.core.git_status(f.project.id).unwrap().ahead, 0);
}

#[test]
fn push_is_refused_when_behind_and_ahead() {
    let f = fixture();
    f.core.create_branch(f.project.id, "topic").unwrap();
    commit_file(&f.work, "t.txt", "t\n");
    f.core.push(f.project.id, false).unwrap();
    // Someone else advances the branch, and so do we.
    git(&f.other, &["fetch", "-q"]);
    git(&f.other, &["checkout", "-q", "topic"]);
    commit_file(&f.other, "o.txt", "o\n");
    git(&f.other, &["push", "-q"]);
    let remote_head = git(&f.remote, &["rev-parse", "topic"]);
    commit_file(&f.work, "w.txt", "w\n");
    f.core
        .fetch_project_at(f.project.id, Instant::now() + FETCH_INTERVAL)
        .unwrap();
    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!((status.ahead, status.behind), (1, 1));

    let err = f.core.push(f.project.id, false).unwrap_err();

    assert!(err.to_string().contains("fast-forward"), "{err}");
    assert_eq!(git(&f.remote, &["rev-parse", "topic"]), remote_head);
}

#[test]
fn push_never_overwrites_a_remote_the_view_has_not_seen() {
    // Not fetched, so the counts say ahead-only; Git itself must still refuse.
    let f = fixture();
    commit_file(&f.other, "o.txt", "o\n");
    git(&f.other, &["push", "-q"]);
    commit_file(&f.work, "w.txt", "w\n");
    let remote_head = git(&f.remote, &["rev-parse", "main"]);

    assert!(f.core.push(f.project.id, true).is_err());
    assert_eq!(git(&f.remote, &["rev-parse", "main"]), remote_head);
}

#[test]
fn no_core_code_path_passes_force() {
    for file in ["src/git.rs", "src/lib.rs"] {
        let src =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(file)).unwrap();
        for forbidden in ["--force", "\"-f\"", "+HEAD", "--mirror"] {
            let hits = src
                .lines()
                .filter(|l| l.contains(forbidden) && !l.trim_start().starts_with("//"));
            assert_eq!(hits.count(), 0, "{file} contains {forbidden}");
        }
    }
}
