use oxide_core::{Core, DiffHunk, DiffKind, DiffScope, DiffStatus, ProjectSummary};
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

fn commit_file(dir: &Path, name: &str, content: &str) {
    std::fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", name]);
}

struct Fixture {
    tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    work: PathBuf,
}

/// A checkout on `main` with one commit (`a.txt`, `b.txt`).
fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let scan = root.join("scan");
    let work = scan.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    commit_file(&work, "a.txt", "one\ntwo\nthree\n");
    commit_file(&work, "b.txt", "keep\n");

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().into_owned()];
    core.save_settings(&settings).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
    Fixture {
        tmp,
        core,
        project,
        work,
    }
}

fn lines(hunk: &DiffHunk) -> Vec<(DiffKind, &str)> {
    hunk.lines
        .iter()
        .map(|l| (l.kind, l.text.as_str()))
        .collect()
}

#[test]
fn uncommitted_lists_staged_unstaged_and_untracked_changes_with_hunks() {
    let f = fixture();
    // Staged edit, unstaged edit, untracked file.
    std::fs::write(f.work.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    git(&f.work, &["add", "a.txt"]);
    std::fs::write(f.work.join("b.txt"), "keep\nmore\n").unwrap();
    std::fs::write(f.work.join("new.txt"), "x\ny\n").unwrap();

    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    let paths: Vec<_> = diff.files.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt", "new.txt"]);

    let a = &diff.files[0];
    assert_eq!(a.status, DiffStatus::Modified);
    assert_eq!((a.added, a.removed), (1, 1));
    assert_eq!(
        lines(&a.hunks[0]),
        [
            (DiffKind::Context, "one"),
            (DiffKind::Removed, "two"),
            (DiffKind::Added, "TWO"),
            (DiffKind::Context, "three"),
        ]
    );

    let b = &diff.files[1];
    assert_eq!((b.added, b.removed), (1, 0));
    assert!(lines(&b.hunks[0]).contains(&(DiffKind::Added, "more")));

    let new = &diff.files[2];
    assert_eq!(new.status, DiffStatus::Untracked);
    assert_eq!((new.added, new.removed), (2, 0));
    assert_eq!(
        lines(&new.hunks[0]),
        [(DiffKind::Added, "x"), (DiffKind::Added, "y")]
    );
}

#[test]
fn uncommitted_reports_deletes_renames_and_binary_files() {
    let f = fixture();
    std::fs::remove_file(f.work.join("b.txt")).unwrap();
    git(&f.work, &["mv", "a.txt", "renamed.txt"]);
    std::fs::write(f.work.join("img.bin"), [0u8, 1, 2, 0]).unwrap();

    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    let find = |p: &str| diff.files.iter().find(|d| d.path == p).unwrap();
    assert_eq!(find("b.txt").status, DiffStatus::Deleted);
    assert_eq!(find("b.txt").removed, 1);
    let renamed = find("renamed.txt");
    assert_eq!(renamed.status, DiffStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("a.txt"));
    let bin = find("img.bin");
    assert!(bin.binary && bin.hunks.is_empty());
}

#[test]
fn uncommitted_is_empty_for_a_clean_checkout() {
    let f = fixture();
    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    assert!(diff.files.is_empty());
}

#[test]
fn branch_shows_changes_since_the_merge_base_with_the_base_branch() {
    let f = fixture();
    git(&f.work, &["checkout", "-q", "-b", "topic"]);
    commit_file(&f.work, "t.txt", "topic\n");
    std::fs::write(f.work.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    git(&f.work, &["commit", "-qam", "edit a"]);
    // The base moves on; those changes are not the branch's.
    git(&f.work, &["checkout", "-q", "main"]);
    commit_file(&f.work, "main-only.txt", "m\n");
    git(&f.work, &["checkout", "-q", "topic"]);
    // Uncommitted work is not part of the Branch scope.
    std::fs::write(f.work.join("b.txt"), "dirty\n").unwrap();

    let diff = f.core.diff(f.project.id, DiffScope::Branch).unwrap();
    assert_eq!(diff.base.as_deref(), Some("main"));
    let paths: Vec<_> = diff.files.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "t.txt"]);
    assert_eq!(diff.files[0].added, 1);
    assert_eq!(diff.files[1].status, DiffStatus::Added);
    assert_eq!(lines(&diff.files[1].hunks[0]), [(DiffKind::Added, "topic")]);
}

#[test]
fn branch_prefers_the_remote_default_branch_and_is_empty_on_the_base_itself() {
    let f = fixture();
    let on_base = f.core.diff(f.project.id, DiffScope::Branch).unwrap();
    assert!(on_base.files.is_empty());

    let remote = f.tmp.path().join("remote.git");
    git(
        f.tmp.path(),
        &["init", "-q", "--bare", "-b", "trunk", "remote.git"],
    );
    git(
        &f.work,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&f.work, &["push", "-q", "origin", "main:trunk"]);
    git(&f.work, &["fetch", "-q", "origin"]);
    git(&f.work, &["remote", "set-head", "origin", "trunk"]);
    git(&f.work, &["checkout", "-q", "-b", "topic"]);
    commit_file(&f.work, "t.txt", "t\n");

    let diff = f.core.diff(f.project.id, DiffScope::Branch).unwrap();
    assert_eq!(diff.base.as_deref(), Some("origin/trunk"));
    assert_eq!(diff.files.len(), 1);
}
