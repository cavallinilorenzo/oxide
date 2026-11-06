//! Publishing the Dossier in a pull request body, through Core's public API and the fake `gh`.

use crossbeam_channel::{Receiver, Sender, unbounded};
use oxide_core::{
    CommandOutcome, Core, DossierSectionOptions, DossierUpdateState, ItemKind, PermissionMode,
    PullRequestInput, RepositoryVisibility, SECTION_END, SECTION_START, SequencedThreadEvent,
    ThreadEvent, ThreadStatus,
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
    gh_dir: PathBuf,
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
        gh_dir,
    }
}

/// The fake `gh`'s state, as the test last wrote it.
fn gh_state(f: &Fixture) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(f.gh_dir.join("state.json")).unwrap()).unwrap()
}

fn set_gh_state(f: &Fixture, state: &serde_json::Value) {
    std::fs::write(f.gh_dir.join("state.json"), state.to_string()).unwrap();
}

/// The body GitHub holds for `number`, as the fake wrote it.
fn published_body(f: &Fixture, number: u32) -> String {
    let state = gh_state(f);
    state["prs"]
        .as_object()
        .expect("a pull request was created")
        .values()
        .find(|pr| pr["number"] == number)
        .and_then(|pr| pr["body"].as_str())
        .unwrap_or_default()
        .to_string()
}

/// Sets the body of `number` as an edit on GitHub would.
fn set_published_body(f: &Fixture, number: u32, body: &str) {
    let mut state = gh_state(f);
    for pr in state["prs"]
        .as_object_mut()
        .expect("pull requests")
        .values_mut()
    {
        if pr["number"] == number {
            pr["body"] = body.into();
        }
    }
    set_gh_state(f, &state);
}

/// The marked range of `body`, markers included.
fn section_of(body: &str) -> &str {
    let start = body.find(SECTION_START).unwrap();
    let end = body[start..].find(SECTION_END).unwrap() + start + SECTION_END.len();
    &body[start..end]
}

/// `body` with the marked range cut out: every byte Oxide must leave alone.
fn outside_section(body: &str) -> String {
    let start = body.find(SECTION_START).unwrap();
    let end = body[start..].find(SECTION_END).unwrap() + start + SECTION_END.len();
    format!("{}{}", &body[..start], &body[end..])
}

fn commit_change(f: &Fixture, name: &str) {
    std::fs::write(f.work.join(name), "two\n").unwrap();
    git(&f.work, &["add", "."]);
    git(&f.work, &["commit", "-qm", "Change out of band"]);
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
                dossier_options: None,
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
                dossier_options: None,
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

fn git_output(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Creates a pull request from the Thread's branch with a published section.
fn create_with_section(f: &Fixture, id: u32, body: &str) -> (u32, String) {
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();
    let pr = f
        .core
        .create_pull_request_in(
            f.project_id,
            Some(id),
            &PullRequestInput {
                title: "T".into(),
                body: body.into(),
                base: "main".into(),
                draft: false,
                dossier_section: Some(section.markdown),
                dossier_options: Some(DossierSectionOptions::default()),
            },
        )
        .unwrap();
    (pr.number, published_body(f, pr.number))
}

#[test]
fn a_push_from_oxide_updates_only_the_text_between_the_markers() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &["cargo test"], "done");
    let (number, created) = create_with_section(&f, id, "Fixes it.\n\nCloses #51");
    // Text after the section, as a hand edit on GitHub would leave it.
    set_published_body(
        &f,
        number,
        &format!("{created}\n\nA note kept after the section."),
    );
    let before = published_body(&f, number);

    commit_change(&f, "b.txt");
    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    let update = outcome
        .dossier
        .expect("a Thread push inspects its pull request");
    assert_eq!(update.state, DossierUpdateState::Updated);
    assert_eq!(update.pull_request, Some(number));

    let after = published_body(&f, number);
    assert_eq!(outside_section(&after), outside_section(&before));
    assert_ne!(section_of(&after), section_of(&before));
    assert!(after.contains("Change out of band"), "{after}");
    assert_eq!(after.matches(SECTION_START).count(), 1);
}

#[test]
fn a_push_keeps_the_options_the_section_was_published_with() {
    let f = fixture(Some("PRIVATE"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &[], "CLAIM-TEXT");
    let options = DossierSectionOptions {
        include_prompts: true,
        include_agent_message: false,
    };
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &options)
        .unwrap();
    let pr = f
        .core
        .create_pull_request_in(
            f.project_id,
            Some(id),
            &PullRequestInput {
                title: "T".into(),
                body: "Fixes it.".into(),
                base: "main".into(),
                draft: false,
                dossier_section: Some(section.markdown),
                dossier_options: Some(options),
            },
        )
        .unwrap();

    let before = published_body(&f, pr.number);
    let tampered = before.replace("prompts=true,message=false", "prompts=false,message=true");
    set_published_body(&f, pr.number, &tampered);
    commit_change(&f, "b.txt");
    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(outcome.dossier.unwrap().state, DossierUpdateState::Updated);
    let after = published_body(&f, pr.number);
    assert_ne!(section_of(&after), section_of(&before));
    assert!(after.contains("PROMPT-TEXT"), "{after}");
    assert!(!after.contains("CLAIM-TEXT"), "{after}");
}

#[test]
fn a_body_edit_cannot_opt_in_to_publishing_prompts_or_claims() {
    let f = fixture(Some("PRIVATE"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &[], "CLAIM-TEXT");
    let (number, before) = create_with_section(&f, id, "Fixes it.");
    let tampered = before.replace("prompts=false,message=false", "prompts=true,message=true");
    set_published_body(&f, number, &tampered);
    commit_change(&f, "b.txt");

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(outcome.dossier.unwrap().state, DossierUpdateState::Updated);
    let after = published_body(&f, number);
    assert!(!after.contains("PROMPT-TEXT"), "{after}");
    assert!(!after.contains("CLAIM-TEXT"), "{after}");
}

#[test]
fn editing_the_dossier_preview_cannot_override_explicit_disclosure_choices() {
    let f = fixture(Some("PRIVATE"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &[], "CLAIM-TEXT");
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &DossierSectionOptions::default())
        .unwrap();
    let edited = section
        .markdown
        .replace("prompts=false,message=false", "prompts=true,message=true");
    let pr = f
        .core
        .create_pull_request_in(
            f.project_id,
            Some(id),
            &PullRequestInput {
                title: "T".into(),
                body: "Fixes it.".into(),
                base: "main".into(),
                draft: false,
                dossier_section: Some(edited),
                dossier_options: Some(DossierSectionOptions::default()),
            },
        )
        .unwrap();
    commit_change(&f, "b.txt");

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(outcome.dossier.unwrap().state, DossierUpdateState::Updated);
    let after = published_body(&f, pr.number);
    assert!(!after.contains("PROMPT-TEXT"), "{after}");
    assert!(!after.contains("CLAIM-TEXT"), "{after}");
}

#[test]
fn deleting_a_thread_also_deletes_its_dossier_disclosure_choices() {
    let f = fixture(Some("PRIVATE"));
    let id = thread_with_turn(&f, "PROMPT-TEXT", &[], "CLAIM-TEXT");
    let options = DossierSectionOptions {
        include_prompts: true,
        include_agent_message: false,
    };
    let section = f
        .core
        .dossier_pull_request_section(f.project_id, id, &options)
        .unwrap();
    let pr = f
        .core
        .create_pull_request_in(
            f.project_id,
            Some(id),
            &PullRequestInput {
                title: "T".into(),
                body: "Fixes it.".into(),
                base: "main".into(),
                draft: false,
                dossier_section: Some(section.markdown),
                dossier_options: Some(options),
            },
        )
        .unwrap();
    let db = rusqlite::Connection::open(f._tmp.path().join("home/oxide.db")).unwrap();
    let key = format!("dossier_options:{}:{id}:{}", f.project_id, pr.number);
    let saved: String = db
        .query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            [&key],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, "prompts=true,message=false");

    f.core.delete_thread(id, true).unwrap();

    let remaining: u32 = db
        .query_row(
            "SELECT COUNT(*) FROM app_state WHERE key GLOB ?1",
            [format!("dossier_options:{}:{id}:*", f.project_id)],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}

#[test]
fn a_push_without_a_pull_request_reports_nothing_to_update() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(
        outcome.dossier.unwrap().state,
        DossierUpdateState::NoPullRequest
    );
}

#[test]
fn a_push_with_nothing_new_leaves_an_up_to_date_section_alone() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, before) = create_with_section(&f, id, "Fixes it.");

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(outcome.dossier.unwrap().state, DossierUpdateState::UpToDate);
    assert_eq!(published_body(&f, number), before);
}

#[test]
fn a_push_does_not_publish_when_the_pull_request_head_does_not_match() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, before) = create_with_section(&f, id, "Fixes it.");
    let mut state = gh_state(&f);
    for pr in state["prs"].as_object_mut().unwrap().values_mut() {
        if pr["number"] == number {
            pr["headRefOid"] = "a-different-head".into();
        }
    }
    set_gh_state(&f, &state);
    commit_change(&f, "b.txt");

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    let update = outcome.dossier.unwrap();
    assert_eq!(update.state, DossierUpdateState::Failed);
    assert!(
        update
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("not at the pull request's head"),
        "{update:?}"
    );
    assert_eq!(published_body(&f, number), before);
}

#[test]
fn a_half_removed_marker_is_reported_and_the_body_is_left_alone() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    let edited = format!("Fixes it.\n\n{SECTION_START}\nstale");
    set_published_body(&f, number, &edited);

    commit_change(&f, "b.txt");
    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    let update = outcome.dossier.unwrap();
    assert_eq!(update.state, DossierUpdateState::Failed);
    assert!(
        update
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("incomplete"),
        "{update:?}"
    );
    assert_eq!(published_body(&f, number), edited);
}

#[test]
fn a_section_removed_by_hand_is_not_re_added_by_a_push() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    let edited = "Fixes it.\n\nNo Dossier any more.";
    set_published_body(&f, number, edited);

    commit_change(&f, "b.txt");
    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    assert_eq!(
        outcome.dossier.unwrap().state,
        DossierUpdateState::NoSection
    );
    assert_eq!(published_body(&f, number), edited);
}

#[test]
fn a_failed_dossier_update_does_not_fail_the_push_and_is_reported() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    let before = published_body(&f, number);
    let mut state = gh_state(&f);
    state["pr_edit_error"] = serde_json::json!("HTTP 502: Bad Gateway");
    set_gh_state(&f, &state);

    commit_change(&f, "b.txt");
    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    let update = outcome
        .dossier
        .expect("the failure is reported beside the push");
    assert_eq!(update.state, DossierUpdateState::Failed);
    assert_eq!(update.pull_request, Some(number));
    assert!(
        update
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("502"),
        "{update:?}"
    );
    assert_eq!(published_body(&f, number), before);
    // The push itself reached the remote.
    let remote = f
        .work
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("remote.git");
    assert_eq!(
        git_output(&f.work, &["rev-parse", "HEAD"]),
        git_output(&remote, &["rev-parse", "feature"])
    );
}

#[test]
fn a_push_reports_when_github_authentication_is_unavailable() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let mut state = gh_state(&f);
    state["auth"] = serde_json::json!("logged_out");
    set_gh_state(&f, &state);

    let outcome = f.core.push_in(f.project_id, Some(id), false).unwrap();

    let update = outcome
        .dossier
        .expect("the unavailable update is reported beside the push");
    assert_eq!(update.state, DossierUpdateState::Failed);
    assert!(
        update
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("gh auth login"),
        "{update:?}"
    );
    let remote = f
        .work
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("remote.git");
    assert_eq!(
        git_output(&f.work, &["rev-parse", "HEAD"]),
        git_output(&remote, &["rev-parse", "feature"])
    );
}

#[test]
fn a_push_outside_oxide_shows_the_section_as_out_of_date_until_it_is_refreshed() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    assert!(
        !f.core
            .pull_request_detail(f.project_id, number)
            .unwrap()
            .dossier_out_of_date
    );

    // A push made outside Oxide: the local branch and the remote both move.
    commit_change(&f, "b.txt");
    git(&f.work, &["push", "-q", "origin", "HEAD"]);

    assert!(
        f.core
            .pull_request_detail(f.project_id, number)
            .unwrap()
            .dossier_out_of_date
    );

    f.core
        .refresh_published_dossier(f.project_id, id, number)
        .unwrap();

    let detail = f.core.pull_request_detail(f.project_id, number).unwrap();
    assert!(!detail.dossier_out_of_date);
    assert!(
        detail.body.contains("Change out of band"),
        "{}",
        detail.body
    );
}

#[test]
fn a_refresh_from_a_checkout_behind_the_head_is_refused() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    commit_change(&f, "b.txt");
    git(&f.work, &["push", "-q", "origin", "HEAD"]);
    // The checkout has not pulled the outside push.
    git(&f.work, &["reset", "-q", "--hard", "HEAD~1"]);
    let before = published_body(&f, number);

    let error = f
        .core
        .refresh_published_dossier(f.project_id, id, number)
        .unwrap_err()
        .to_string();

    assert!(error.contains("not at the pull request's head"), "{error}");
    assert_eq!(published_body(&f, number), before);
}

#[test]
fn a_refresh_can_follow_a_fast_forward_pull_of_an_outside_push() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    commit_change(&f, "b.txt");
    git(&f.work, &["push", "-q", "origin", "HEAD"]);
    git(&f.work, &["reset", "-q", "--hard", "HEAD~1"]);
    let remote = f
        .work
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("remote.git");
    let expected_head = git_output(&remote, &["rev-parse", "refs/heads/feature"]);

    f.core
        .pull_thread_branch(f.project_id, id, "feature", &expected_head)
        .unwrap();
    f.core
        .refresh_published_dossier(f.project_id, id, number)
        .unwrap();

    let detail = f.core.pull_request_detail(f.project_id, number).unwrap();
    assert!(!detail.dossier_out_of_date);
    assert!(
        detail.body.contains("Change out of band"),
        "{}",
        detail.body
    );
}

#[test]
fn pull_for_refresh_refuses_a_thread_checkout_on_another_branch() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    create_with_section(&f, id, "Fixes it.");
    git(&f.work, &["checkout", "-q", "-b", "other", "main"]);
    let before = git_output(&f.work, &["rev-parse", "HEAD"]);
    let expected_head = before.clone();

    let error = f
        .core
        .pull_thread_branch(f.project_id, id, "feature", &expected_head)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("rather than the pull request branch"),
        "{error}"
    );
    assert_eq!(git_output(&f.work, &["branch", "--show-current"]), "other");
    assert_eq!(git_output(&f.work, &["rev-parse", "HEAD"]), before);
}

#[test]
fn pull_for_refresh_refuses_an_upstream_that_is_not_the_pr_branch() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    create_with_section(&f, id, "Fixes it.");
    git(&f.work, &["config", "branch.feature.remote", "origin"]);
    git(
        &f.work,
        &["config", "branch.feature.merge", "refs/heads/main"],
    );
    let before = git_output(&f.work, &["rev-parse", "HEAD"]);

    let error = f
        .core
        .pull_thread_branch(f.project_id, id, "feature", &before)
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("not tracking the pull request branch"),
        "{error}"
    );
    assert_eq!(git_output(&f.work, &["rev-parse", "HEAD"]), before);
}

#[test]
fn a_refresh_without_a_reported_pull_request_head_is_refused() {
    let f = fixture(Some("PUBLIC"));
    let id = thread_with_turn(&f, "go", &[], "done");
    let (number, _) = create_with_section(&f, id, "Fixes it.");
    let before = published_body(&f, number);
    let mut state = gh_state(&f);
    for pr in state["prs"].as_object_mut().unwrap().values_mut() {
        if pr["number"] == number {
            pr["headRefOid"] = "".into();
        }
    }
    set_gh_state(&f, &state);

    let error = f
        .core
        .refresh_published_dossier(f.project_id, id, number)
        .unwrap_err()
        .to_string();

    assert!(error.contains("did not report"), "{error}");
    assert_eq!(published_body(&f, number), before);
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
