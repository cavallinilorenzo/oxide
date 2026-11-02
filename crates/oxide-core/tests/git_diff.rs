use oxide_core::{
    Core, DiffHunk, DiffKind, DiffScope, DiffStatus, ProjectSummary, RevertHunk, RevertScope,
    RevertTarget,
};
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
    let project = core.add_project(&work.to_string_lossy()).unwrap();
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

fn numbered(n: std::ops::RangeInclusive<u32>) -> String {
    n.map(|i| format!("line{i}\n")).collect()
}

fn read(f: &Fixture, name: &str) -> String {
    std::fs::read_to_string(f.work.join(name)).unwrap()
}

fn file_target(path: &str) -> RevertTarget {
    RevertTarget {
        path: path.into(),
        hunk: None,
    }
}

#[test]
fn reverting_a_hunk_leaves_the_other_hunks_of_the_file_untouched() {
    let f = fixture();
    commit_file(&f.work, "long.txt", &numbered(1..=30));
    let edited = numbered(1..=30)
        .replace("line2\n", "TWO\n")
        .replace("line28\n", "TWENTY-EIGHT\n");
    std::fs::write(f.work.join("long.txt"), edited).unwrap();

    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    let hunks = &diff.files[0].hunks;
    assert_eq!(hunks.len(), 2);
    let target = RevertTarget {
        path: "long.txt".into(),
        hunk: Some(RevertHunk {
            index: 1,
            header: hunks[1].header.clone(),
        }),
    };
    f.core
        .revert_in(f.project.id, None, RevertScope::Uncommitted, &target, false)
        .unwrap();

    let expected = numbered(1..=30).replace("line2\n", "TWO\n");
    assert_eq!(read(&f, "long.txt"), expected);
}

fn revert(f: &Fixture, path: &str, confirm: bool) -> oxide_core::Result<()> {
    f.core.revert_in(
        f.project.id,
        None,
        RevertScope::Uncommitted,
        &file_target(path),
        confirm,
    )
}

#[test]
fn reverting_a_file_restores_it_and_leaves_other_files_alone() {
    let f = fixture();
    std::fs::write(f.work.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    git(&f.work, &["add", "a.txt"]);
    std::fs::write(f.work.join("a.txt"), "ONE\nTWO\nthree\n").unwrap();
    std::fs::write(f.work.join("b.txt"), "keep\nmore\n").unwrap();

    revert(&f, "a.txt", false).unwrap();

    assert_eq!(read(&f, "a.txt"), "one\ntwo\nthree\n");
    assert_eq!(read(&f, "b.txt"), "keep\nmore\n");
    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    let paths: Vec<_> = diff.files.iter().map(|d| d.path.as_str()).collect();
    assert_eq!(paths, ["b.txt"]);
}

#[test]
fn reverting_a_stale_hunk_is_refused_instead_of_reverting_another_one() {
    let f = fixture();
    commit_file(&f.work, "long.txt", &numbered(1..=30));
    let edited = numbered(1..=30).replace("line2\n", "TWO\n");
    std::fs::write(f.work.join("long.txt"), &edited).unwrap();
    let target = RevertTarget {
        path: "long.txt".into(),
        hunk: Some(RevertHunk {
            index: 0,
            header: "@@ -9,9 +9,9 @@".into(),
        }),
    };
    f.core
        .revert_in(f.project.id, None, RevertScope::Uncommitted, &target, false)
        .unwrap_err();
    assert_eq!(read(&f, "long.txt"), edited);
}

#[test]
fn deleting_an_untracked_or_added_file_needs_confirmation() {
    let f = fixture();
    std::fs::write(f.work.join("new.txt"), "x\n").unwrap();
    std::fs::write(f.work.join("staged.txt"), "y\n").unwrap();
    git(&f.work, &["add", "staged.txt"]);

    for path in ["new.txt", "staged.txt"] {
        let err = revert(&f, path, false).unwrap_err();
        assert!(err.to_string().contains("deletes"), "{err}");
        assert!(f.work.join(path).exists());

        revert(&f, path, true).unwrap();
        assert!(!f.work.join(path).exists());
    }
    let diff = f.core.diff(f.project.id, DiffScope::Uncommitted).unwrap();
    assert!(diff.files.is_empty());
}

#[test]
fn reverting_a_deleted_file_brings_it_back() {
    let f = fixture();
    std::fs::remove_file(f.work.join("b.txt")).unwrap();
    revert(&f, "b.txt", false).unwrap();
    assert_eq!(read(&f, "b.txt"), "keep\n");
}
