use crossbeam_channel::Receiver;
use oxide_core::{
    CommentScope, CommentSide, Core, NewLineComment, PermissionMode, SequencedThreadEvent,
    ThreadEvent, ThreadStatus,
};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    work: PathBuf,
    project_id: u32,
    thread_id: u32,
    prompts: Arc<Mutex<Vec<String>>>,
    release: Arc<Mutex<bool>>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("scan/work");
    std::fs::create_dir_all(&work).unwrap();
    git(&work, &["init", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);
    std::fs::write(work.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();

    let core = Core::open(tmp.path().join("home")).unwrap();
    core.set_real_time_ticker(false);
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    let thread_id = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let release = Arc::new(Mutex::new(true));
    let fake = FakeProvider::default();
    let sender = fake.sender();
    let (seen, gate) = (prompts.clone(), release.clone());
    fake.on_prompt(move |prompt| {
        seen.lock().unwrap().push(prompt.to_string());
        let (sender, gate, prompt) = (sender.clone(), gate.clone(), prompt.to_string());
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            while !*gate.lock().unwrap() {
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    core.register_fake_provider(thread_id, fake);
    Fixture {
        _tmp: tmp,
        core,
        work,
        project_id,
        thread_id,
        prompts,
        release,
    }
}

fn wait_for(rx: &Receiver<SequencedThreadEvent>, accept: impl Fn(&ThreadEvent) -> bool) {
    loop {
        let evt = rx.recv_timeout(Duration::from_secs(5)).expect("timed out");
        if accept(&evt.event) {
            return;
        }
    }
}

fn draft(path: &str, side: CommentSide, line: u32, code: &str, body: &str) -> NewLineComment {
    NewLineComment {
        scope: CommentScope::Uncommitted,
        path: path.into(),
        side,
        line,
        code: code.into(),
        body: body.into(),
    }
}

#[test]
fn drafts_are_added_edited_deleted_and_belong_to_their_thread() {
    let f = fixture();
    let c = f
        .core
        .add_line_comment(
            f.thread_id,
            draft("a.txt", CommentSide::New, 2, "TWO", "why upper?"),
        )
        .unwrap();
    f.core.edit_line_comment(c.id, "why uppercase?").unwrap();
    let listed = f.core.list_line_comments(f.thread_id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].body, "why uppercase?");
    assert!(!listed[0].outdated);

    let other = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    assert!(f.core.list_line_comments(other).unwrap().is_empty());

    f.core.delete_line_comment(c.id).unwrap();
    assert!(f.core.list_line_comments(f.thread_id).unwrap().is_empty());
}

#[test]
fn drafts_survive_reopening_core() {
    let f = fixture();
    f.core
        .add_line_comment(
            f.thread_id,
            draft("a.txt", CommentSide::New, 4, "four", "needed?"),
        )
        .unwrap();
    let home = f.core.home().to_path_buf();
    drop(f.core);
    let core = Core::open(home).unwrap();
    assert_eq!(core.list_line_comments(f.thread_id).unwrap().len(), 1);
}

#[test]
fn a_draft_whose_line_changed_is_flagged_outdated() {
    let f = fixture();
    f.core
        .add_line_comment(f.thread_id, draft("a.txt", CommentSide::New, 2, "TWO", "x"))
        .unwrap();
    f.core
        .add_line_comment(f.thread_id, draft("a.txt", CommentSide::Old, 2, "two", "y"))
        .unwrap();
    assert!(
        f.core
            .list_line_comments(f.thread_id)
            .unwrap()
            .iter()
            .all(|c| !c.outdated)
    );
    std::fs::write(f.work.join("a.txt"), "one\nTwo!\nthree\nfour\n").unwrap();
    let listed = f.core.list_line_comments(f.thread_id).unwrap();
    assert!(
        listed
            .iter()
            .find(|c| c.side == CommentSide::New)
            .unwrap()
            .outdated
    );
    assert!(
        !listed
            .iter()
            .find(|c| c.side == CommentSide::Old)
            .unwrap()
            .outdated
    );
}

#[test]
fn sending_delivers_every_draft_in_one_prompt_and_clears_them() {
    let f = fixture();
    f.core
        .add_line_comment(
            f.thread_id,
            draft("a.txt", CommentSide::New, 2, "TWO", "why upper?"),
        )
        .unwrap();
    f.core
        .add_line_comment(
            f.thread_id,
            draft("a.txt", CommentSide::New, 4, "four", "drop this"),
        )
        .unwrap();
    f.core.send_line_comments(f.thread_id).unwrap();
    f.core.tick_thread(f.thread_id);

    let prompts = f.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    for expected in [
        "a.txt:2",
        "a.txt:4",
        "TWO",
        "four",
        "why upper?",
        "drop this",
    ] {
        assert!(
            prompts[0].contains(expected),
            "{expected} missing in {}",
            prompts[0]
        );
    }
    drop(prompts);
    assert!(f.core.list_line_comments(f.thread_id).unwrap().is_empty());
}

#[test]
fn sending_is_refused_while_the_thread_is_working_and_keeps_the_drafts() {
    let f = fixture();
    *f.release.lock().unwrap() = false;
    let (_, rx) = f.core.subscribe_thread(f.thread_id).unwrap();
    f.core.send_prompt(f.thread_id, "go").unwrap();
    f.core.tick_thread(f.thread_id);
    wait_for(&rx, |e| matches!(e, ThreadEvent::TurnStarted { .. }));

    f.core
        .add_line_comment(f.thread_id, draft("a.txt", CommentSide::New, 2, "TWO", "x"))
        .unwrap();
    assert!(f.core.send_line_comments(f.thread_id).is_err());
    assert_eq!(f.core.list_line_comments(f.thread_id).unwrap().len(), 1);

    *f.release.lock().unwrap() = true;
    f.core.tick_thread(f.thread_id);
    wait_for(&rx, |e| {
        matches!(
            e,
            ThreadEvent::ThreadStatusChanged {
                status: ThreadStatus::Completed
            }
        )
    });
    f.core.send_line_comments(f.thread_id).unwrap();
}

#[test]
fn sending_without_drafts_is_an_error() {
    let f = fixture();
    assert!(f.core.send_line_comments(f.thread_id).is_err());
}

#[test]
fn deleting_a_thread_deletes_its_drafts() {
    let f = fixture();
    f.core
        .add_line_comment(f.thread_id, draft("a.txt", CommentSide::New, 2, "TWO", "x"))
        .unwrap();
    f.core.delete_thread(f.thread_id, true).unwrap();
    assert!(f.core.list_line_comments(f.thread_id).unwrap().is_empty());
}
