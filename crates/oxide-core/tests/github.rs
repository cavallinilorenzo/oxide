use oxide_core::{
    Core, GithubAvailability, Notification, ProjectSummary, PullRequestInput, System,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

const FAKE_GH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/gh/gh");

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

fn commit_file(dir: &Path, name: &str, content: &str, message: &str) {
    std::fs::write(dir.join(name), content).unwrap();
    git(dir, &["add", name]);
    git(dir, &["commit", "-qm", message]);
}

#[derive(Default)]
struct RecordingSystem {
    opened: Mutex<Vec<String>>,
}

impl System for RecordingSystem {
    fn hold_activity(&self) {}
    fn release_activity(&self) {}
    fn notify(&self, _: Notification) {}
    fn set_badge(&self, _: u32) {}
    fn open_url(&self, url: &str) {
        self.opened.lock().unwrap().push(url.to_string());
    }
}

struct Fixture {
    _tmp: TempDir,
    core: Core,
    project: ProjectSummary,
    remote: PathBuf,
    work: PathBuf,
    /// The directory holding the fake `gh`, the only entry on its PATH.
    gh_dir: PathBuf,
    system: Arc<RecordingSystem>,
}

impl Fixture {
    fn set_gh(&self, state: serde_json::Value) {
        std::fs::write(self.gh_dir.join("state.json"), state.to_string()).unwrap();
    }

    /// Every `gh` invocation so far, as its argument list.
    fn gh_calls(&self) -> Vec<Vec<String>> {
        let log = std::fs::read_to_string(self.gh_dir.join("calls.jsonl")).unwrap_or_default();
        log.lines()
            .map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).unwrap();
                v["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_string())
                    .collect()
            })
            .collect()
    }

    fn create_calls(&self) -> Vec<Vec<String>> {
        self.gh_calls()
            .into_iter()
            .filter(|c| c[..2] == ["pr", "create"])
            .collect()
    }
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let remote = root.join("remote.git");
    let scan = root.join("scan");
    std::fs::create_dir_all(&scan).unwrap();
    git(root, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
    let seed = root.join("seed");
    git(
        root,
        &[
            "clone",
            "-q",
            remote.to_str().unwrap(),
            seed.to_str().unwrap(),
        ],
    );
    git(&seed, &["checkout", "-q", "-b", "main"]);
    commit_file(&seed, "a.txt", "one\n", "Seed");
    git(&seed, &["push", "-q", "-u", "origin", "main"]);
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
    git(&work, &["config", "user.name", "T"]);
    git(&work, &["config", "user.email", "t@example.com"]);

    let gh_dir = root.join("bin");
    std::fs::create_dir_all(&gh_dir).unwrap();

    let core = Core::open(root.join("home")).unwrap();
    core.set_real_time_ticker(false);
    let mut settings = core.settings().settings;
    settings.scan_roots = vec![scan.to_string_lossy().into_owned()];
    core.save_settings(&settings).unwrap();
    let project = core.rescan_projects().unwrap().remove(0);
    let system = Arc::new(RecordingSystem::default());
    core.set_system(system.clone());
    core.set_gh_search_path(Some(vec![gh_dir.clone()]));
    Fixture {
        _tmp: tmp,
        core,
        project,
        remote,
        work,
        gh_dir,
        system,
    }
}

fn install_gh(f: &Fixture, state: serde_json::Value) {
    for name in ["gh", "gh.py"] {
        let from = Path::new(FAKE_GH).with_file_name(name);
        std::fs::copy(from, f.gh_dir.join(name)).unwrap();
    }
    f.set_gh(state);
}

fn ok_state() -> serde_json::Value {
    serde_json::json!({"auth": "ok", "default_branch": "main", "next_number": 7, "prs": {}})
}

fn input(title: &str, base: &str, draft: bool) -> PullRequestInput {
    PullRequestInput {
        title: title.into(),
        body: "Body".into(),
        base: base.into(),
        draft,
    }
}

#[test]
fn missing_gh_is_reported_with_install_guidance_and_git_still_works() {
    let f = fixture(); // nothing on the PATH
    let state = f.core.pull_request_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::Missing);
    assert!(state.guidance.unwrap().contains("Install"));
    assert!(state.pull_request.is_none());
    assert_eq!(
        f.core.git_status(f.project.id).unwrap().branch.as_deref(),
        Some("main")
    );
}

#[test]
fn logged_out_gh_is_reported_with_login_guidance_and_git_still_works() {
    let f = fixture();
    install_gh(&f, serde_json::json!({"auth": "logged_out"}));
    let state = f.core.pull_request_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::LoggedOut);
    assert!(state.guidance.unwrap().contains("gh auth login"));
    f.core.create_branch(f.project.id, "feature").unwrap();
    assert_eq!(
        f.core.git_status(f.project.id).unwrap().branch.as_deref(),
        Some("feature")
    );
}

#[test]
fn state_reports_the_default_branch_and_the_open_pull_request_of_the_branch() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    let state = f.core.pull_request_state(f.project.id).unwrap();
    assert_eq!(state.availability, GithubAvailability::Ready);
    assert_eq!(state.default_branch.as_deref(), Some("main"));
    assert_eq!(state.branch.as_deref(), Some("feature"));
    assert!(state.pull_request.is_none());

    f.set_gh(serde_json::json!({
        "auth": "ok", "default_branch": "main",
        "prs": {"feature": {
            "number": 3, "title": "Add feature", "url": "https://github.com/fake/repo/pull/3",
            "state": "OPEN", "isDraft": true, "baseRefName": "main", "headRefName": "feature"
        }}
    }));
    let pr = f
        .core
        .pull_request_state(f.project.id)
        .unwrap()
        .pull_request
        .unwrap();
    assert_eq!((pr.number, pr.title.as_str()), (3, "Add feature"));
    assert!(pr.draft);
    assert_eq!(pr.base, "main");
}

#[test]
fn a_merged_pull_request_does_not_count_as_the_branchs_pull_request() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    f.set_gh(serde_json::json!({
        "auth": "ok", "default_branch": "main",
        "prs": {"feature": {
            "number": 3, "title": "Old", "url": "https://github.com/fake/repo/pull/3",
            "state": "MERGED", "isDraft": false, "baseRefName": "main", "headRefName": "feature"
        }}
    }));
    assert!(
        f.core
            .pull_request_state(f.project.id)
            .unwrap()
            .pull_request
            .is_none()
    );
}

#[test]
fn draft_is_prefilled_from_the_commits_against_the_default_branch() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "add-things").unwrap();
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    let one = f.core.pull_request_draft(f.project.id).unwrap();
    assert_eq!(one.title, "Add b");
    assert_eq!(one.base, "main");
    assert_eq!(one.head, "add-things");

    commit_file(&f.work, "c.txt", "c\n", "Add c");
    let two = f.core.pull_request_draft(f.project.id).unwrap();
    assert_eq!(two.title, "Add things");
    assert_eq!(two.body, "- Add b\n- Add c");
}

#[test]
fn create_pushes_when_needed_and_calls_gh_with_the_chosen_title_base_and_draft() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    assert!(f.core.git_status(f.project.id).unwrap().unpublished);

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("My PR", "main", true))
        .unwrap();

    assert_eq!(pr.number, 7);
    assert!(pr.draft);
    // The branch reached the remote before gh was asked to open the PR.
    assert!(
        !git(&f.remote, &["branch", "--list", "feature"])
            .trim()
            .is_empty()
    );
    assert!(!f.core.git_status(f.project.id).unwrap().unpublished);
    assert_eq!(
        f.create_calls(),
        [[
            "pr", "create", "--title", "My PR", "--body", "Body", "--base", "main", "--head",
            "feature", "--draft"
        ]]
    );
    // The new PR is what the Surface now shows.
    let shown = f.core.pull_request_state(f.project.id).unwrap();
    assert_eq!(shown.pull_request.unwrap().number, 7);
}

#[test]
fn create_without_draft_omits_the_flag_and_skips_the_push_when_published() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    commit_file(&f.work, "b.txt", "b\n", "Add b");
    f.core.push(f.project.id, false).unwrap();
    let before = git(&f.remote, &["rev-parse", "feature"]);

    let pr = f
        .core
        .create_pull_request(f.project.id, &input("Ready", "develop", false))
        .unwrap();

    assert!(!pr.draft);
    assert_eq!(pr.base, "develop");
    assert!(!f.create_calls()[0].contains(&"--draft".to_string()));
    assert_eq!(git(&f.remote, &["rev-parse", "feature"]), before);
}

#[test]
fn create_is_refused_from_the_protected_branch_and_without_gh() {
    let f = fixture();
    let err = f
        .core
        .create_pull_request(f.project.id, &input("T", "main", false))
        .unwrap_err();
    assert!(err.to_string().contains("Install"), "{err}");

    install_gh(&f, ok_state());
    let err = f
        .core
        .create_pull_request(f.project.id, &input("T", "main", false))
        .unwrap_err();
    assert!(err.to_string().contains("main"), "{err}");
    assert!(f.create_calls().is_empty());

    f.core.create_branch(f.project.id, "feature").unwrap();
    let err = f
        .core
        .create_pull_request(f.project.id, &input("  ", "main", false))
        .unwrap_err();
    assert!(err.to_string().contains("title"), "{err}");
}

#[test]
fn open_pull_request_hands_its_url_to_the_system() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    assert!(f.core.open_pull_request(f.project.id).is_err());

    commit_file(&f.work, "b.txt", "b\n", "Add b");
    f.core
        .create_pull_request(f.project.id, &input("PR", "main", false))
        .unwrap();
    f.core.open_pull_request(f.project.id).unwrap();
    assert_eq!(
        *f.system.opened.lock().unwrap(),
        ["https://github.com/fake/repo/pull/7"]
    );
}

#[test]
fn gh_is_only_called_when_asked_so_there_is_no_polling() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    f.core.git_status(f.project.id).unwrap();
    f.core.list_branches(f.project.id).unwrap();
    assert!(f.gh_calls().is_empty());
    f.core.pull_request_state(f.project.id).unwrap();
    let after_one = f.gh_calls().len();
    assert!(after_one > 0);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(f.gh_calls().len(), after_one);
}
