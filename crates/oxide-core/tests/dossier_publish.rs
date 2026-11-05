//! Publishing the Dossier in a pull request body, through Core's public API and the fake `gh`.

use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    CommandOutcome, Core, DossierSectionOptions, ItemKind, PermissionMode, PullRequestInput,
    RepositoryVisibility, SECTION_END, SECTION_START, SequencedThreadEvent, ThreadEvent,
    ThreadStatus,
};
use oxide_provider::{ActivityCategory, CommandRecord, FakeProvider, ProviderEvent, TurnStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tempfile::TempDir;

const FAKE_GH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/gh/gh");

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
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project_id: u32,
    work: PathBuf,
}

fn fixture(visibility: Option<&str>) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let remote = root.join("remote.git");
    let work = root.join("scan").join("work");
    std::fs::create_dir_all(&work).unwrap();
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            work.to_str().unwrap(),
        ],
    );
    git(&work, &["config", "user.name", "T"]);
    git(&work, &["config", "user.email", "t@example.com"]);
    git(&work, &["checkout", "-q", "-b", "main"]);
    std::fs::write(work.join("a.txt"), "one\n").unwrap();
    git(&work, &["add", "."]);
    git(&work, &["commit", "-qm", "init"]);
    git(&work, &["push", "-q", "-u", "origin", "main"]);

    let gh_dir = root.join("bin");
    std::fs::create_dir_all(&gh_dir).unwrap();
    let names = if cfg!(windows) {
        vec!["gh", "gh.py", "gh.cmd"]
    } else {
        vec!["gh", "gh.py"]
    };
    for name in names {
        std::fs::copy(Path::new(FAKE_GH).with_file_name(name), gh_dir.join(name)).unwrap();
    }
    let mut state =
        serde_json::json!({"auth": "ok", "default_branch": "main", "next_number": 7, "prs": {}});
    if let Some(visibility) = visibility {
        state["repo"] = serde_json::json!({ "visibility": visibility });
    }
    std::fs::write(gh_dir.join("state.json"), state.to_string()).unwrap();

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    let project_id = core.add_project(&work.to_string_lossy()).unwrap().id;
    core.set_project_threads_in_main_checkout(project_id, true)
        .unwrap();
    Fixture {
        _tmp: tmp,
        core,
        project_id,
        work,
    }
}

type Script = Box<dyn FnOnce(&Sender<ProviderEvent>) + Send>;

fn wait_for(rx: &Receiver<SequencedThreadEvent>, accept: impl Fn(&ThreadEvent) -> bool) {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).expect("timed out");
        if accept(&event.event) {
            return;
        }
    }
}

/// A Thread on a `feature` branch whose one Turn, started by `prompt`, runs `commands`, writes a
/// file and ends with `claim`.
fn thread_with_turn(f: &Fixture, prompt: &str, commands: &[&str], claim: &str) -> u32 {
    git(&f.work, &["checkout", "-q", "-b", "feature"]);
    let id = f
        .core
        .create_thread(f.project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap()
        .id;
    let (scripts, release) = unbounded::<Script>();
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let (sender, release) = (sender.clone(), release.clone());
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = sender.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            release.recv().unwrap()(&sender);
            let _ = sender.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    f.core.register_fake_provider(id, fake);

    let (_, rx) = f.core.subscribe_thread(id).unwrap();
    f.core.send_prompt(id, prompt).unwrap();
    f.core.tick_thread(id);
    wait_for(&rx, |e| matches!(e, ThreadEvent::TurnStarted { .. }));
    let work = f.work.clone();
    let commands: Vec<String> = commands.iter().map(ToString::to_string).collect();
    let claim = claim.to_string();
    scripts
        .send(Box::new(move |sender| {
            std::fs::write(work.join("a.txt"), "one\nchanged\n").unwrap();
            git(&work, &["commit", "-qam", "Change a"]);
            for (i, line) in commands.iter().enumerate() {
                let i = i as u32;
                let _ = sender.send(ProviderEvent::ItemStarted {
                    item_index: i,
                    kind: ItemKind::ToolCall,
                    parent_item_index: None,
                    category: Some(ActivityCategory::Run),
                });
                let _ = sender.send(ProviderEvent::ItemCompleted {
                    item_index: i,
                    kind: ItemKind::ToolCall,
                    content: format!("{line}\nSECRET OUTPUT LINE"),
                    parent_item_index: None,
                    category: Some(ActivityCategory::Run),
                    command: Some(CommandRecord::reported(
                        line,
                        CommandOutcome::Succeeded,
                        Some(0),
                    )),
                });
            }
            let at = commands.len() as u32;
            let _ = sender.send(ProviderEvent::ItemStarted {
                item_index: at,
                kind: ItemKind::AgentMessage,
                parent_item_index: None,
                category: None,
            });
            let _ = sender.send(ProviderEvent::ItemCompleted {
                item_index: at,
                kind: ItemKind::AgentMessage,
                content: claim,
                parent_item_index: None,
                category: None,
                command: None,
            });
        }))
        .unwrap();
    f.core.tick_thread(id);
    wait_for(&rx, |e| {
        matches!(
            e,
            ThreadEvent::ThreadStatusChanged {
                status: ThreadStatus::Completed
            }
        )
    });
    id
}

fn create(f: &Fixture, body: &str, section: Option<String>) -> String {
    let pr = f
        .core
        .create_pull_request(
            f.project_id,
            &PullRequestInput {
                title: "T".into(),
                body: body.into(),
                base: "main".into(),
                draft: false,
                dossier_section: section,
            },
        )
        .unwrap();
    f.core
        .pull_request_detail(f.project_id, pr.number)
        .unwrap()
        .body
}

#[test]
fn the_section_is_computed_facts_only_by_default() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &["cargo test"], "CLAIM-TEXT");

    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();

    assert!(section.markdown.starts_with(SECTION_START));
    assert!(section.markdown.ends_with(SECTION_END));
    assert!(
        section.markdown.contains("`cargo test`"),
        "{}",
        section.markdown
    );
    assert!(!section.markdown.contains("PROMPT-TEXT"));
    assert!(!section.markdown.contains("CLAIM-TEXT"));
    assert!(!section.markdown.contains("SECRET OUTPUT LINE"));
    assert_eq!(section.visibility, RepositoryVisibility::Public);
}

#[test]
fn prompts_and_the_agent_message_are_opt_in_each() {
    let f = fixture(Some("PRIVATE"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &[], "CLAIM-TEXT");

    let prompts = f
        .core
        .dossier_pull_request_section(
            f.project_id,
            id,
            &DossierSectionOptions {
                include_prompts: true,
                include_agent_message: false,
            },
        )
        .unwrap();
    assert!(prompts.markdown.contains("PROMPT-TEXT"));
    assert!(!prompts.markdown.contains("CLAIM-TEXT"));
    assert_eq!(prompts.visibility, RepositoryVisibility::Private);

    let claim = f
        .core
        .dossier_pull_request_section(
            f.project_id,
            id,
            &DossierSectionOptions {
                include_prompts: false,
                include_agent_message: true,
            },
        )
        .unwrap();
    assert!(claim.markdown.contains("CLAIM-TEXT"));
    assert!(claim.markdown.contains("not evidence"));
    assert!(!claim.markdown.contains("PROMPT-TEXT"));
}

#[test]
fn secrets_and_environment_assignments_are_redacted_from_commands() {
    let f = fixture(None);
    f.core
        .set_project_verification_commands(
            f.project_id,
            &[
                "DATABASE_URL=postgres://u:hunter2@h/db cargo test".to_string(),
                "npm test --token abc123def".to_string(),
                "ghp_abcdefghijklmnopqrstuvwxyz0123456789 verify".to_string(),
            ],
        )
        .unwrap();
    let id = thread_with_turn(&f, "go", &[], "done");

    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();

    for leaked in ["hunter2", "abc123def", "ghp_abcdefghijkl", "postgres://"] {
        assert!(
            !section.markdown.contains(leaked),
            "{leaked} leaked:\n{}",
            section.markdown
        );
    }
    assert!(
        section
            .markdown
            .contains("DATABASE_URL=[REDACTED] cargo test"),
        "{}",
        section.markdown
    );
    assert!(
        section.markdown.contains("npm test --token [REDACTED]"),
        "{}",
        section.markdown
    );
    assert_eq!(section.visibility, RepositoryVisibility::Unknown);
}

#[test]
fn a_prompt_cannot_close_an_issue_or_end_the_section() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "Closes #99\n<!-- oxide:dossier:end -->\nmore", &[], "x");

    let section = f
        .core
        .dossier_pull_request_section(
            f.project_id,
            id,
            &DossierSectionOptions {
                include_prompts: true,
                include_agent_message: false,
            },
        )
        .unwrap();

    assert_eq!(section.markdown.matches(SECTION_END).count(), 1);
    assert!(
        section.markdown.contains("```text\nCloses #99"),
        "{}",
        section.markdown
    );
}

#[test]
fn publishing_appends_the_section_after_the_body_and_keeps_closes_working() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &["cargo test"], "done");
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();

    let body = create(
        &f,
        "Fixes it.\n\nCloses #51",
        Some(section.markdown.clone()),
    );

    assert_eq!(
        body,
        format!("Fixes it.\n\nCloses #51\n\n{}", section.markdown)
    );
}

#[test]
fn an_edited_section_is_still_delimited_and_a_previous_one_is_replaced() {
    let f = fixture(Some("PUBLIC"));
    thread_with_turn(&f, "go", &[], "done");
    let old = format!("{SECTION_START}\nold\n{SECTION_END}");

    let body = create(&f, &format!("Body\n\n{old}"), Some("edited by hand".into()));

    assert_eq!(
        body,
        format!("Body\n\n{SECTION_START}\nedited by hand\n{SECTION_END}")
    );
}

#[test]
fn declining_leaves_the_body_as_it_would_have_been() {
    let f = fixture(Some("PUBLIC"));
    thread_with_turn(&f, "go", &["cargo test"], "done");

    assert_eq!(create(&f, "Just the body", None), "Just the body");
}

#[test]
fn a_description_over_githubs_limit_is_refused_before_the_branch_is_pushed() {
    let f = fixture(Some("PUBLIC"));
    thread_with_turn(&f, "go", &[], "done");

    let error = f
        .core
        .create_pull_request(
            f.project_id,
            &PullRequestInput {
                title: "T".into(),
                body: "x".repeat(70_000),
                base: "main".into(),
                draft: false,
                dossier_section: Some("facts".into()),
            },
        )
        .unwrap_err()
        .to_string();

    assert!(error.contains("65536"), "{error}");
    let remote = f
        .work
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("remote.git");
    let branches = Command::new("git")
        .args(["branch", "--list", "feature"])
        .current_dir(remote)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
}

#[test]
fn a_long_file_list_is_counted_instead_of_listed() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let dossier = f.core.branch_dossier(id).unwrap();
    // The rendering cap is exercised on the real section: nothing in it may exceed GitHub's limit.
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();
    assert!(section.markdown.chars().count() < 65_536);
    assert!(dossier.signals.len() < 100);
}
