use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    Core, DiffStatus, PermissionMode, RevertScope, RevertTarget, SequencedThreadEvent, ThreadEvent,
    ThreadStatus,
};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
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
    project_id: u32,
    work: PathBuf,
    /// Per Thread, where its fake Provider receives each Turn's edit.
    gates: Mutex<HashMap<u32, Sender<Edit>>>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let scan = root.join("scan");
    let work = scan.join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    std::fs::write(work.join("b.txt"), "keep\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    // Checkpoints are tested against the main checkout, so keep Threads out of worktrees here.
    core.set_project_threads_in_main_checkout(project_id, true)
        .unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
        gates: Mutex::default(),
    }
}

type Edit = Box<dyn FnOnce() + Send>;

/// A fake whose every Turn starts, then waits for an edit on `release`, runs it and completes.
fn gated_fake(release: Receiver<Edit>) -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let (sender, release) = (sender.clone(), release.clone());
        let prompt = prompt.to_string();
        // Off the actor's thread, which must stay free to take the Checkpoints.
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            release.recv().unwrap()();
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    fake
}

fn wait_for(rx: &Receiver<SequencedThreadEvent>, accept: impl Fn(&ThreadEvent) -> bool) {
    loop {
        let evt = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("timed out waiting for a thread event");
        if accept(&evt.event) {
            return;
        }
    }
}

fn is_started(e: &ThreadEvent) -> bool {
    matches!(e, ThreadEvent::TurnStarted { .. })
}

fn is_completed(e: &ThreadEvent) -> bool {
    matches!(
        e,
        ThreadEvent::ThreadStatusChanged {
            status: ThreadStatus::Completed
        }
    )
}

/// Runs one Turn whose edit is `edit`; returns once it is completed.
fn run_turn(f: &Fixture, thread_id: u32, edit: impl FnOnce() + Send + 'static) {
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_started);
    f.gates.lock().unwrap()[&thread_id]
        .send(Box::new(edit))
        .unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_completed);
}

fn new_thread(f: &Fixture) -> u32 {
    let id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let (gate, release) = unbounded();
    f.core.register_fake_provider(id, gated_fake(release));
    f.gates.lock().unwrap().insert(id, gate);
    id
}

/// Everything a Checkpoint must leave alone, as bytes.
fn user_state(work: &Path) -> Vec<String> {
    vec![
        std::fs::read(work.join(".git/index"))
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        git(work, &["rev-parse", "HEAD"]),
        git(
            work,
            &["for-each-ref", "refs/heads", "refs/stash", "refs/remotes"],
        ),
        git(work, &["stash", "list"]),
        git(work, &["status", "--porcelain=v1"]),
    ]
}

fn checkpoint_refs(work: &Path) -> Vec<String> {
    git(
        work,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/oxide/checkpoints",
        ],
    )
    .lines()
    .map(str::to_string)
    .collect()
}

#[test]
fn a_turn_makes_two_checkpoints_and_the_turn_scope_shows_exactly_what_changed_between_them() {
    let f = fixture();
    let thread_id = new_thread(&f);
    // Dirty before the Turn: not the Turn's change.
    std::fs::write(f.work.join("b.txt"), "keep\nbefore\n").unwrap();
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });

    assert_eq!(checkpoint_refs(&f.work).len(), 2);
    let diff = f.core.turn_diff(thread_id, 0).unwrap();
    let mut files: Vec<_> = diff
        .files
        .iter()
        .map(|d| (d.path.as_str(), d.status, d.added))
        .collect();
    files.sort_by_key(|(p, ..)| *p);
    assert_eq!(
        files,
        [
            ("a.txt", DiffStatus::Modified, 1),
            ("new.txt", DiffStatus::Added, 1)
        ]
    );
}

#[test]
fn checkpoints_leave_index_stash_head_and_branches_byte_for_byte_unchanged() {
    let f = fixture();
    let thread_id = new_thread(&f);
    // A stash entry, a staged change, an unstaged one and an untracked file.
    std::fs::write(f.work.join("a.txt"), "stashed\n").unwrap();
    git(&f.work, &["stash", "-q"]);
    std::fs::write(f.work.join("a.txt"), "staged\n").unwrap();
    git(&f.work, &["add", "a.txt"]);
    std::fs::write(f.work.join("b.txt"), "unstaged\n").unwrap();
    std::fs::write(f.work.join("untracked.txt"), "u\n").unwrap();
    let before = user_state(&f.work);

    // The Turn itself changes nothing in the checkout.
    run_turn(&f, thread_id, || {});

    assert_eq!(checkpoint_refs(&f.work).len(), 2);
    assert_eq!(user_state(&f.work), before);
    assert!(f.core.turn_diff(thread_id, 0).unwrap().files.is_empty());
}

#[test]
fn each_turn_is_diffed_on_its_own() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\nfirst\n").unwrap()
    });
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("b.txt"), "keep\nsecond\n").unwrap()
    });

    assert_eq!(checkpoint_refs(&f.work).len(), 4);
    let paths = |turn| -> Vec<String> {
        f.core
            .turn_diff(thread_id, turn)
            .unwrap()
            .files
            .into_iter()
            .map(|d| d.path)
            .collect()
    };
    assert_eq!(paths(0), ["a.txt"]);
    assert_eq!(paths(1), ["b.txt"]);
}

#[test]
fn a_turn_without_checkpoints_has_an_empty_diff() {
    let f = fixture();
    let thread_id = new_thread(&f);
    assert!(f.core.turn_diff(thread_id, 7).unwrap().files.is_empty());
}

fn turn_target(path: &str) -> RevertTarget {
    RevertTarget {
        path: path.into(),
        hunk: None,
    }
}

fn read(f: &Fixture, name: &str) -> String {
    // Git on Windows may write CRLF.
    std::fs::read_to_string(f.work.join(name))
        .unwrap()
        .replace("\r\n", "\n")
}

#[test]
fn reverting_a_file_of_the_turn_leaves_the_rest_of_the_turn_and_earlier_work_alone() {
    let f = fixture();
    let thread_id = new_thread(&f);
    std::fs::write(f.work.join("b.txt"), "keep\nbefore\n").unwrap();
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });

    let revert = |path: &str, confirm| {
        f.core.revert_in(
            f.project_id,
            Some(thread_id),
            RevertScope::Turn,
            &turn_target(path),
            confirm,
        )
    };
    revert("a.txt", false).unwrap();
    assert_eq!(read(&f, "a.txt"), "one\n");
    assert_eq!(read(&f, "new.txt"), "fresh\n");
    assert_eq!(read(&f, "b.txt"), "keep\nbefore\n");

    // A file the Turn created is deleted, after a confirmation.
    revert("new.txt", false).unwrap_err();
    assert!(f.work.join("new.txt").exists());
    revert("new.txt", true).unwrap();
    assert!(!f.work.join("new.txt").exists());
}

#[test]
fn a_turn_revert_that_conflicts_with_later_edits_changes_nothing_and_says_why() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
    });
    // The user rewrote the Turn's change after it ended.
    std::fs::write(f.work.join("a.txt"), "completely different\n").unwrap();

    let err = f
        .core
        .revert_in(
            f.project_id,
            Some(thread_id),
            RevertScope::Turn,
            &turn_target("a.txt"),
            false,
        )
        .unwrap_err();
    assert!(err.to_string().contains("a.txt"), "{err}");
    assert!(err.to_string().contains("Nothing was reverted"), "{err}");
    assert_eq!(read(&f, "a.txt"), "completely different\n");
}

#[test]
fn nothing_is_reverted_while_a_turn_is_running_in_the_checkout() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_started);
    std::fs::write(f.work.join("a.txt"), "one\nmid-turn\n").unwrap();

    let err = f
        .core
        .revert_in(
            f.project_id,
            None,
            RevertScope::Uncommitted,
            &turn_target("a.txt"),
            false,
        )
        .unwrap_err();
    assert!(err.to_string().contains("working"), "{err}");
    assert_eq!(read(&f, "a.txt"), "one\nmid-turn\n");

    f.gates.lock().unwrap()[&thread_id]
        .send(Box::new(|| {}))
        .unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_completed);
}

#[test]
fn the_turn_picks_name_each_turn_by_position_and_prompt_and_tell_which_have_checkpoints() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = f.work.clone();
    run_turn(&f, thread_id, move || {
        std::fs::write(work.join("a.txt"), "one\nfirst\n").unwrap()
    });
    run_turn(&f, thread_id, || {});

    let picks = f.core.turn_picks(thread_id).unwrap();
    assert_eq!(
        picks.iter().map(|p| p.turn_index).collect::<Vec<_>>(),
        [0, 1]
    );
    assert!(picks.iter().all(|p| p.checkpointed && !p.prompt.is_empty()));

    // Checkpoints are refs in the checkout; without them a Turn has nothing to diff.
    for name in checkpoint_refs(&f.work) {
        git(&f.work, &["update-ref", "-d", &name]);
    }
    let picks = f.core.turn_picks(thread_id).unwrap();
    assert!(picks.iter().all(|p| !p.checkpointed));
}
