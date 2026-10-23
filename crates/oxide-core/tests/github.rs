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
    let names = if cfg!(windows) {
        vec!["gh", "gh.py", "gh.cmd"]
    } else {
        vec!["gh", "gh.py"]
    };
    for name in names {
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
fn reloading_the_surface_asks_github_only_for_the_pull_request() {
    let f = fixture();
    install_gh(&f, ok_state());
    f.core.create_branch(f.project.id, "feature").unwrap();
    f.core.pull_request_state(f.project.id).unwrap();
    f.core.pull_request_draft(f.project.id).unwrap();
    let before = f.gh_calls().len();

    f.core.pull_request_state(f.project.id).unwrap();
    f.core.pull_request_draft(f.project.id).unwrap();

    let again: Vec<_> = f.gh_calls()[before..]
        .iter()
        .map(|c| c[..2].join(" "))
        .collect();
    assert_eq!(
        again,
        ["pr view"],
        "auth status and the default branch are reused"
    );
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

fn pr_json(number: u32, title: &str, head: &str, author: &str) -> serde_json::Value {
    serde_json::json!({
        "number": number, "title": title, "state": "OPEN", "isDraft": false,
        "url": format!("https://github.com/fake/repo/pull/{number}"),
        "baseRefName": "main", "headRefName": head, "author": {"login": author},
    })
}

const PR_DIFF: &str = "diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..2f8e1a0
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/a.txt b/a.txt
index 5626abf..f719efd 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+uno
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 5626abf..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
";

fn state_with_prs(prs: &[serde_json::Value]) -> serde_json::Value {
    let by_head: serde_json::Map<String, serde_json::Value> = prs
        .iter()
        .map(|p| (p["headRefName"].as_str().unwrap().to_string(), p.clone()))
        .collect();
    serde_json::json!({"auth": "ok", "default_branch": "main", "prs": by_head})
}

fn detailed_pr() -> serde_json::Value {
    let mut pr = pr_json(5, "Add b", "add-b", "other");
    pr["body"] = "Adds b.".into();
    pr["diff"] = PR_DIFF.into();
    pr["comments"] = serde_json::json!([
        {"author": {"login": "reviewer"}, "body": "Looks good", "createdAt": "2026-05-01T10:00:00Z"}
    ]);
    pr["statusCheckRollup"] = serde_json::json!([
        {"__typename": "CheckRun", "name": "rust", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"__typename": "CheckRun", "name": "web", "status": "COMPLETED", "conclusion": "FAILURE"},
        {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": ""},
        {"__typename": "StatusContext", "context": "ci/legacy", "state": "SUCCESS"},
    ]);
    pr
}

fn numbers(prs: &[oxide_core::PullRequest]) -> Vec<u32> {
    prs.iter().map(|p| p.number).collect()
}

#[test]
fn list_shows_open_pull_requests_mine_or_all_and_searches_them() {
    let f = fixture();
    let mut merged = pr_json(3, "Old", "old", "me");
    merged["state"] = "MERGED".into();
    install_gh(
        &f,
        state_with_prs(&[
            pr_json(1, "Fix login", "fix-login", "me"),
            pr_json(2, "Add search", "add-search", "other"),
            merged,
        ]),
    );
    let all = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert_eq!(numbers(&all), [1, 2]);
    assert_eq!(all[1].author, "other");
    assert_eq!(all[0].head, "fix-login");

    let mine = f.core.list_pull_requests(f.project.id, true, "").unwrap();
    assert_eq!(numbers(&mine), [1]);

    let found = f
        .core
        .list_pull_requests(f.project.id, false, "search")
        .unwrap();
    assert_eq!(numbers(&found), [2]);
}

#[test]
fn list_without_gh_explains_how_to_get_it() {
    let f = fixture();
    let err = f
        .core
        .list_pull_requests(f.project.id, false, "")
        .unwrap_err();
    assert!(err.to_string().contains("Install"), "{err}");
}

#[test]
fn detail_has_description_checks_comments_and_changed_files() {
    let f = fixture();
    install_gh(&f, state_with_prs(&[detailed_pr()]));
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();

    assert_eq!(detail.pull_request.title, "Add b");
    assert_eq!(detail.body, "Adds b.");
    let checks: Vec<(&str, &str)> = detail
        .checks
        .iter()
        .map(|c| (c.name.as_str(), c.state.as_str()))
        .collect();
    assert_eq!(
        checks,
        [
            ("rust", "success"),
            ("web", "failure"),
            ("e2e", "pending"),
            ("ci/legacy", "success")
        ]
    );
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].author, "reviewer");
    assert_eq!(detail.comments[0].body, "Looks good");

    let files: Vec<(&str, Option<&str>, u32, u32)> = detail
        .diff
        .files
        .iter()
        .map(|d| (d.path.as_str(), d.old_path.as_deref(), d.added, d.removed))
        .collect();
    assert_eq!(
        files,
        [
            ("b.txt", None, 2, 0),
            ("a.txt", None, 1, 1),
            ("new.txt", Some("old.txt"), 0, 0),
            ("gone.txt", None, 0, 1)
        ]
    );
    assert_eq!(detail.diff.files[0].hunks[0].lines[1].text, "two");
    assert_eq!(detail.diff.base.as_deref(), Some("main"));
}

#[test]
fn detail_offers_only_the_merge_methods_the_repository_allows() {
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({
        "mergeCommitAllowed": false, "squashMergeAllowed": true,
        "rebaseMergeAllowed": false, "deleteBranchOnMerge": true,
    });
    install_gh(&f, state);
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.merge_methods, [oxide_core::MergeMethod::Squash]);
    assert!(detail.delete_branch_on_merge);
}

#[test]
fn comment_sends_the_body_and_shows_up_on_the_next_view() {
    let f = fixture();
    install_gh(&f, state_with_prs(&[detailed_pr()]));
    f.core
        .comment_pull_request(f.project.id, 5, "  Thanks!  ")
        .unwrap();
    assert!(
        f.gh_calls().contains(
            &["pr", "comment", "5", "--body", "Thanks!"]
                .map(String::from)
                .to_vec()
        )
    );
    let detail = f.core.pull_request_detail(f.project.id, 5).unwrap();
    assert_eq!(detail.comments.last().unwrap().body, "Thanks!");

    let before = f.gh_calls().len();
    assert!(f.core.comment_pull_request(f.project.id, 5, "  ").is_err());
    assert_eq!(f.gh_calls().len(), before);
}

#[test]
fn merge_uses_an_allowed_method_and_can_delete_the_branch() {
    use oxide_core::MergeMethod;
    let f = fixture();
    let mut state = state_with_prs(&[detailed_pr()]);
    state["repo"] = serde_json::json!({"rebaseMergeAllowed": false});
    install_gh(&f, state);
    let merge_calls = || -> Vec<Vec<String>> {
        f.gh_calls()
            .into_iter()
            .filter(|c| c[..2] == ["pr", "merge"])
            .collect()
    };

    let err = f
        .core
        .merge_pull_request(f.project.id, 5, MergeMethod::Rebase, false)
        .unwrap_err();
    assert!(err.to_string().contains("rebase"), "{err}");
    assert!(merge_calls().is_empty());

    f.core
        .merge_pull_request(f.project.id, 5, MergeMethod::Squash, true)
        .unwrap();
    assert_eq!(
        merge_calls(),
        [["pr", "merge", "5", "--squash", "--delete-branch"]]
    );
    // Merged pull requests leave the open list.
    let open = f.core.list_pull_requests(f.project.id, false, "").unwrap();
    assert!(open.is_empty());
}

/// Publishes `add-b` (with `file` holding `content`) and leaves `main` checked out.
fn publish_pr_branch(f: &Fixture, file: &str, content: &str) {
    git(&f.work, &["checkout", "-q", "-b", "add-b"]);
    commit_file(&f.work, file, content, "Add b");
    git(&f.work, &["push", "-q", "origin", "add-b"]);
    git(&f.work, &["checkout", "-q", "main"]);
    git(&f.work, &["branch", "-q", "-D", "add-b"]);
}

#[test]
fn checkout_switches_the_main_checkout_to_the_pull_requests_branch() {
    let f = fixture();
    publish_pr_branch(&f, "b.txt", "b\n");
    install_gh(&f, state_with_prs(&[detailed_pr()]));

    f.core.checkout_pull_request(f.project.id, 5).unwrap();

    let status = f.core.git_status(f.project.id).unwrap();
    assert_eq!(status.branch.as_deref(), Some("add-b"));
    assert!(f.work.join("b.txt").exists());
}

#[test]
fn checkout_shows_gits_refusal() {
    let f = fixture();
    publish_pr_branch(&f, "a.txt", "changed upstream\n");
    install_gh(&f, state_with_prs(&[detailed_pr()]));

    // An uncommitted edit to the same file: Git refuses to overwrite it.
    std::fs::write(f.work.join("a.txt"), "local edit\n").unwrap();
    let err = f.core.checkout_pull_request(f.project.id, 5).unwrap_err();

    assert!(err.to_string().contains("a.txt"), "{err}");
    assert_eq!(
        f.core.git_status(f.project.id).unwrap().branch.as_deref(),
        Some("main")
    );
}

#[test]
fn list_and_search_issues_against_fake_gh() {
    let f = fixture();
    install_gh(
        &f,
        serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 3,
            "issues": [
                {
                    "number": 1,
                    "title": "First issue",
                    "body": "Body 1",
                    "state": "OPEN",
                    "author": {"login": "alice"},
                    "url": "https://github.com/fake/repo/issues/1",
                    "createdAt": "2026-01-01T00:00:00Z",
                    "comments": []
                },
                {
                    "number": 2,
                    "title": "Bug in parser",
                    "body": "Details",
                    "state": "OPEN",
                    "author": {"login": "bob"},
                    "url": "https://github.com/fake/repo/issues/2",
                    "createdAt": "2026-01-02T00:00:00Z",
                    "comments": [{"author": {"login": "alice"}, "body": "me too", "createdAt": "2026-01-02T01:00:00Z"}]
                }
            ]
        }),
    );

    let all = f.core.list_issues(f.project.id, "").unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].number, 1);
    assert_eq!(all[0].title, "First issue");
    assert_eq!(all[0].comments_count, 0);
    assert_eq!(all[1].number, 2);
    assert_eq!(all[1].comments_count, 1);

    let searched = f.core.list_issues(f.project.id, "parser").unwrap();
    assert_eq!(searched.len(), 1);
    assert_eq!(searched[0].number, 2);
}

#[test]
fn view_issue_detail_with_comments() {
    let f = fixture();
    install_gh(
        &f,
        serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 3,
            "issues": [
                {
                    "number": 42,
                    "title": "Bug in lexer",
                    "body": "It crashes on null byte",
                    "state": "OPEN",
                    "author": {"login": "charlie"},
                    "url": "https://github.com/fake/repo/issues/42",
                    "createdAt": "2026-01-03T10:00:00Z",
                    "comments": [
                        {
                            "author": {"login": "dave"},
                            "body": "Can confirm on macOS",
                            "createdAt": "2026-01-03T10:30:00Z"
                        }
                    ]
                }
            ]
        }),
    );

    let detail = f.core.issue_detail(f.project.id, 42).unwrap();
    assert_eq!(detail.number, 42);
    assert_eq!(detail.title, "Bug in lexer");
    assert_eq!(detail.body, "It crashes on null byte");
    assert_eq!(detail.author, "charlie");
    assert_eq!(detail.state, "OPEN");
    assert_eq!(detail.url, "https://github.com/fake/repo/issues/42");
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].author, "dave");
    assert_eq!(detail.comments[0].body, "Can confirm on macOS");
}

#[test]
fn create_comment_and_close_issue_calling_gh() {
    let f = fixture();
    install_gh(
        &f,
        serde_json::json!({
            "auth": "ok",
            "default_branch": "main",
            "next_number": 10,
            "issues": []
        }),
    );

    // Create
    let created = f
        .core
        .create_issue(f.project.id, "New Feature", "Feature description")
        .unwrap();
    assert_eq!(created.number, 10);
    assert_eq!(created.title, "New Feature");
    assert_eq!(created.url, "https://github.com/fake/repo/issues/10");

    // List after create shows it
    let list = f.core.list_issues(f.project.id, "").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].number, 10);

    // Comment
    f.core
        .comment_issue(f.project.id, 10, "First thought")
        .unwrap();
    let detail = f.core.issue_detail(f.project.id, 10).unwrap();
    assert_eq!(detail.comments.len(), 1);
    assert_eq!(detail.comments[0].body, "First thought");

    // Open on GitHub
    f.core.open_issue(f.project.id, 10).unwrap();
    assert_eq!(
        *f.system.opened.lock().unwrap(),
        ["https://github.com/fake/repo/issues/10"]
    );

    // Close
    f.core.close_issue(f.project.id, 10).unwrap();
    let open_list = f.core.list_issues(f.project.id, "").unwrap();
    assert_eq!(open_list.len(), 0);

    // Searching finds closed issues
    let search_all = f.core.list_issues(f.project.id, "Feature").unwrap();
    assert_eq!(search_all.len(), 1);
    assert_eq!(search_all[0].state, "CLOSED");
}

#[test]
fn issues_state_reports_guidance_when_missing_or_logged_out() {
    let f = fixture();
    let missing = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(missing.availability, GithubAvailability::Missing);
    assert!(missing.guidance.as_ref().unwrap().contains("Install"));

    install_gh(&f, serde_json::json!({"auth": "logged_out"}));
    let logged_out = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(logged_out.availability, GithubAvailability::LoggedOut);
    assert!(
        logged_out
            .guidance
            .as_ref()
            .unwrap()
            .contains("gh auth login")
    );

    f.set_gh(serde_json::json!({"auth": "ok", "issues": []}));
    let ready = f.core.issues_state(f.project.id).unwrap();
    assert_eq!(ready.availability, GithubAvailability::Ready);
    assert!(ready.guidance.is_none());
}

#[test]
fn a_pull_request_from_an_issue_threads_branch_closes_the_issue() {
    let f = fixture();
    install_gh(&f, ok_state());
    let thread = f
        .core
        .dispatch_thread(oxide_core::DispatchRequest {
            project_id: f.project.id,
            prompt: "Do it".into(),
            provider: "fake".into(),
            model: None,
            effort: None,
            permission_mode: None,
            base_branch: Some("main".into()),
            issue_number: Some(51),
            issue_title: Some("Do it".into()),
        })
        .unwrap();
    let branch = thread.branch.clone().unwrap();
    // Move the branch into the main checkout, where pull requests are created from.
    git(
        &f.work,
        &[
            "worktree",
            "remove",
            "--force",
            &thread.worktree_path.unwrap(),
        ],
    );
    git(&f.work, &["checkout", "-q", &branch]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");

    let draft = f.core.pull_request_draft(f.project.id).unwrap();
    assert!(draft.body.contains("Closes #51"), "{}", draft.body);

    f.core
        .create_pull_request(f.project.id, &input("T", "main", false))
        .unwrap();
    assert_eq!(f.create_calls()[0][5], "Body\n\nCloses #51");
}

#[test]
fn closes_is_not_repeated_when_the_body_already_has_it() {
    let f = fixture();
    install_gh(&f, ok_state());
    let thread = f
        .core
        .dispatch_thread(oxide_core::DispatchRequest {
            project_id: f.project.id,
            prompt: "Do it".into(),
            provider: "fake".into(),
            model: None,
            effort: None,
            permission_mode: None,
            base_branch: Some("main".into()),
            issue_number: Some(51),
            issue_title: None,
        })
        .unwrap();
    git(
        &f.work,
        &[
            "worktree",
            "remove",
            "--force",
            &thread.worktree_path.unwrap(),
        ],
    );
    git(&f.work, &["checkout", "-q", &thread.branch.unwrap()]);
    commit_file(&f.work, "b.txt", "b\n", "Add b");

    let mut with = input("T", "main", false);
    with.body = "Fixes it.\n\ncloses #51".into();
    f.core.create_pull_request(f.project.id, &with).unwrap();
    assert_eq!(f.create_calls()[0][5], "Fixes it.\n\ncloses #51");
}
