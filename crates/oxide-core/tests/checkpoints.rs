use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    Core, DiffStatus, PermissionMode, SequencedThreadEvent, ThreadEvent, ThreadStatus,
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
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().into_owned()];
    core.save_settings(&settings).unwrap();
    let project_id = core.rescan_projects().unwrap().remove(0).id;
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
