use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    Core, PermissionMode, RestoreChange, SequencedThreadEvent, ThreadEvent, ThreadStatus,
};
use oxide_provider::{FakeProvider, FakeRecorder, ItemKind, ProviderEvent, TurnStatus};
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
    /// Per Thread, what its fake Provider was asked.
    recorders: Mutex<HashMap<u32, FakeRecorder>>,
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
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
        gates: Mutex::default(),
        recorders: Mutex::default(),
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

/// Where the Thread's files live: its own worktree, or the Project's checkout when
/// the Project keeps its Threads there.
fn checkout(f: &Fixture, thread_id: u32) -> PathBuf {
    let snapshot = f.core.get_thread_snapshot(thread_id).unwrap();
    PathBuf::from(
        snapshot
            .thread
            .worktree_path
            .clone()
            .unwrap_or_else(|| f.work.to_string_lossy().into_owned()),
    )
}

/// Runs one Turn whose edit is `edit`, which is given the Thread's checkout; returns
/// that checkout.
fn run_turn(f: &Fixture, thread_id: u32, edit: impl FnOnce(&Path) + Send + 'static) -> PathBuf {
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_started);
    let work = checkout(f, thread_id);
    let edit_work = work.clone();
    f.gates.lock().unwrap()[&thread_id]
        .send(Box::new(move || edit(&edit_work)))
        .unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_completed);
    work
}

fn new_thread(f: &Fixture) -> u32 {
    let id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let (gate, release) = unbounded();
    let fake = gated_fake(release);
    f.recorders.lock().unwrap().insert(id, fake.recorder());
    f.core.register_fake_provider(id, fake);
    f.gates.lock().unwrap().insert(id, gate);
    id
}

/// What the Thread's Provider was asked, in order.
fn prompts(f: &Fixture, thread_id: u32) -> Vec<String> {
    f.recorders.lock().unwrap()[&thread_id].prompts()
}

fn read(dir: &Path, name: &str) -> String {
    // Git on Windows may write CRLF.
    std::fs::read_to_string(dir.join(name))
        .unwrap()
        .replace("\r\n", "\n")
}

/// Everything a restore must leave alone. The index is read as its entries,
/// not as bytes: a file the restore rewrites changes the index's cached stat
/// data, which Git refreshes on its own.
fn user_state(work: &Path) -> Vec<String> {
    vec![
        git(work, &["ls-files", "--stage"]),
        git(work, &["rev-parse", "HEAD"]),
        git(
            work,
            &["for-each-ref", "refs/heads", "refs/stash", "refs/remotes"],
        ),
        git(work, &["stash", "list"]),
    ]
}

#[test]
fn a_restore_puts_the_files_back_to_how_they_were_before_the_turn() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });

    // The confirmation names the files that will change.
    let preview = f.core.restore_preview(thread_id, 0).unwrap();
    assert_eq!(
        preview
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.change))
            .collect::<Vec<_>>(),
        [
            ("a.txt", RestoreChange::Rewritten),
            ("new.txt", RestoreChange::Removed),
        ],
    );

    f.core.restore_turn(thread_id, 0).unwrap();
    assert_eq!(read(&work, "a.txt"), "one\n");
    assert!(!work.join("new.txt").exists());
}

#[test]
fn a_restore_takes_a_checkpoint_first_and_can_be_undone() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });
    // The user edits a file of their own before the restore.
    std::fs::write(work.join("b.txt"), "keep\nmine\n").unwrap();

    f.core.restore_turn(thread_id, 0).unwrap();
    assert_eq!(read(&work, "a.txt"), "one\n");
    assert!(!work.join("new.txt").exists());

    // The safety Checkpoint is a Checkpoint of the Thread, like the Turns' own.
    let refs = git(
        &work,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/oxide/checkpoints",
        ],
    );
    assert!(
        refs.lines().any(|name| name.contains("/restore/")),
        "the restore took no safety Checkpoint: {refs}"
    );

    // Undoing the restore returns every file to the safety Checkpoint.
    let outcome = f.core.undo_restore(thread_id).unwrap();
    assert!(outcome.undone);
    assert_eq!(read(&work, "a.txt"), "one\ntwo\n");
    assert_eq!(read(&work, "new.txt"), "fresh\n");
    assert_eq!(read(&work, "b.txt"), "keep\nmine\n");
}

#[test]
fn a_restore_leaves_head_the_branches_the_index_and_the_ignored_files_alone() {
    let f = fixture();
    // The Threads of this Project work in the Project's own checkout, where the
    // user's own Git state lives.
    f.core
        .set_project_threads_in_main_checkout(f.project_id, true)
        .unwrap();
    let thread_id = new_thread(&f);
    // An ignored file of the user's own, a staged change and a branch.
    std::fs::write(f.work.join(".gitignore"), "ignored.txt\n").unwrap();
    git(&f.work, &["add", ".gitignore"]);
    git(&f.work, &["commit", "-qm", "ignore"]);
    std::fs::write(f.work.join("ignored.txt"), "mine\n").unwrap();
    std::fs::write(f.work.join("a.txt"), "staged\n").unwrap();
    git(&f.work, &["add", "a.txt"]);
    git(&f.work, &["branch", "mine"]);
    let before = user_state(&f.work);

    run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });

    f.core.restore_turn(thread_id, 0).unwrap();

    assert_eq!(user_state(&f.work), before);
    // The ignored file is not in any Checkpoint, so it is left alone.
    assert_eq!(read(&f.work, "ignored.txt"), "mine\n");
}

#[test]
fn nothing_is_restored_while_a_turn_is_running() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let (_, rx) = f.core.subscribe_thread(thread_id).unwrap();
    f.core.send_prompt(thread_id, "go").unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_started);
    let work = checkout(&f, thread_id);
    std::fs::write(work.join("a.txt"), "one\nmid-turn\n").unwrap();

    let err = f.core.restore_turn(thread_id, 0).unwrap_err();
    assert!(err.to_string().contains("running"), "{err}");
    assert_eq!(read(&work, "a.txt"), "one\nmid-turn\n");

    f.gates.lock().unwrap()[&thread_id]
        .send(Box::new(|| {}))
        .unwrap();
    f.core.tick_thread(thread_id);
    wait_for(&rx, is_completed);
}

#[test]
fn nothing_is_restored_while_another_working_thread_shares_the_checkout() {
    let f = fixture();
    // The Threads of this Project work in the Project's own checkout, so they
    // share it.
    f.core
        .set_project_threads_in_main_checkout(f.project_id, true)
        .unwrap();
    let first = new_thread(&f);
    let second = new_thread(&f);
    // The first Thread has a Turn to go back to.
    run_turn(&f, first, |_| {});
    // The second Thread starts working in the same checkout.
    let (_, rx) = f.core.subscribe_thread(second).unwrap();
    f.core.send_prompt(second, "go").unwrap();
    f.core.tick_thread(second);
    wait_for(&rx, is_started);

    let err = f.core.restore_turn(first, 0).unwrap_err();
    assert!(err.to_string().contains("working"), "{err}");
    assert_eq!(read(&f.work, "a.txt"), "one\n");

    f.gates.lock().unwrap()[&second]
        .send(Box::new(|| {}))
        .unwrap();
    f.core.tick_thread(second);
    wait_for(&rx, is_completed);
}

#[test]
fn a_turn_without_a_checkpoint_cannot_be_restored() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let err = f.core.restore_turn(thread_id, 7).unwrap_err();
    assert!(err.to_string().contains("Checkpoint"), "{err}");
}

#[test]
fn the_undo_puts_back_the_files_the_restore_changed_and_leaves_later_work_alone() {
    let f = fixture();
    let thread_id = new_thread(&f);
    let work = run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });
    f.core.restore_turn(thread_id, 0).unwrap();

    // Work done after the restore is not the restore's to undo.
    run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("later.txt"), "later\n").unwrap();
    });

    let outcome = f.core.undo_restore(thread_id).unwrap();
    assert!(outcome.undone);
    assert_eq!(read(&work, "a.txt"), "one\ntwo\n");
    assert_eq!(read(&work, "new.txt"), "fresh\n");
    assert_eq!(read(&work, "later.txt"), "later\n");
}

#[test]
fn a_thread_working_in_another_checkout_does_not_block_the_restore() {
    let f = fixture();
    let first = new_thread(&f);
    let second = new_thread(&f);
    let work = run_turn(&f, first, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
    });
    // The second Thread works in its own worktree, so it leaves the first one's
    // files alone.
    let (_, rx) = f.core.subscribe_thread(second).unwrap();
    f.core.send_prompt(second, "go").unwrap();
    f.core.tick_thread(second);
    wait_for(&rx, is_started);

    f.core.restore_turn(first, 0).unwrap();
    assert_eq!(read(&work, "a.txt"), "one\n");

    f.gates.lock().unwrap()[&second]
        .send(Box::new(|| {}))
        .unwrap();
    f.core.tick_thread(second);
    wait_for(&rx, is_completed);
}

#[test]
fn the_restore_is_marked_at_the_end_of_the_thread() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(&f, thread_id, |_| {});
    run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
    });

    f.core.restore_turn(thread_id, 0).unwrap();

    // The mark is at the end of the Thread, not inside the Turn it restores to.
    let snapshot = f.core.get_thread_snapshot(thread_id).unwrap();
    assert!(
        snapshot.turns[0]
            .items
            .iter()
            .all(|item| item.kind != ItemKind::RestoreMarker)
    );
    assert!(
        snapshot.turns[1]
            .items
            .iter()
            .any(|item| item.kind == ItemKind::RestoreMarker)
    );
    // The mark names the Turn the files went back to, not the one it sits in.
    let marker = snapshot.turns[1]
        .items
        .iter()
        .find(|item| item.kind == ItemKind::RestoreMarker)
        .expect("the restore left no marker in the Transcript");
    assert!(
        marker.content.contains("before Turn 1"),
        "{}",
        marker.content
    );
}

#[test]
fn the_transcript_records_the_restore_and_the_agent_is_told_on_its_next_prompt() {
    let f = fixture();
    let thread_id = new_thread(&f);
    run_turn(&f, thread_id, |work| {
        std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(work.join("new.txt"), "fresh\n").unwrap();
    });

    f.core.restore_turn(thread_id, 0).unwrap();

    // The Transcript says the files went back.
    let snapshot = f.core.get_thread_snapshot(thread_id).unwrap();
    let marker = snapshot.turns[0]
        .items
        .iter()
        .find(|item| item.kind == ItemKind::RestoreMarker)
        .expect("the restore left no marker in the Transcript");
    assert!(marker.content.contains("a.txt"), "{}", marker.content);
    assert!(marker.content.contains("new.txt"), "{}", marker.content);

    // The next prompt tells the agent which files were restored.
    run_turn(&f, thread_id, |_| {});
    let asked = prompts(&f, thread_id);
    let last = asked.last().expect("the Thread asked nothing");
    assert!(last.contains("a.txt"), "{last}");
    assert!(last.contains("new.txt"), "{last}");
}
