use oxide_core::{Core, Notification, System};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
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

#[derive(Default)]
struct RecordingSystem {
    installed: Vec<&'static str>,
    opened: Mutex<Vec<(String, PathBuf)>>,
    revealed: Mutex<Vec<PathBuf>>,
}

impl System for RecordingSystem {
    fn hold_activity(&self) {}
    fn release_activity(&self) {}
    fn notify(&self, _: Notification) {}
    fn set_badge(&self, _: u32) {}
    fn is_app_installed(&self, bundle_id: &str) -> bool {
        self.installed.contains(&bundle_id)
    }
    fn open_with_app(&self, bundle_id: &str, path: &Path) {
        self.opened
            .lock()
            .unwrap()
            .push((bundle_id.into(), path.into()));
    }
    fn reveal_in_finder(&self, path: &Path) {
        self.revealed.lock().unwrap().push(path.into());
    }
}

struct Fixture {
    tmp: TempDir,
    core: Core,
    system: Arc<RecordingSystem>,
}

impl Fixture {
    fn root(&self) -> &Path {
        self.tmp.path()
    }
}

fn fixture(installed: Vec<&'static str>) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let core = Core::open_with_user_home(tmp.path().join("home"), tmp.path().join("user")).unwrap();
    core.set_real_time_ticker(false);
    let system = Arc::new(RecordingSystem {
        installed,
        ..Default::default()
    });
    core.set_system(system.clone());
    Fixture { tmp, core, system }
}

fn make_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-qm", "Seed"]);
}

fn install_gh(f: &Fixture, repos: serde_json::Value) {
    let bin = f.root().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for name in ["gh", "gh.py", "gh.cmd"] {
        std::fs::copy(Path::new(FAKE_GH).with_file_name(name), bin.join(name)).unwrap();
    }
    std::fs::write(
        bin.join("state.json"),
        serde_json::json!({"auth": "ok", "repos": repos}).to_string(),
    )
    .unwrap();
    f.core.set_gh_search_path(Some(vec![bin]));
}

#[test]
fn add_folder_registers_a_project_once() {
    let f = fixture(vec![]);
    let repo = f.root().join("code/app");
    make_repo(&repo);

    let first = f.core.add_project(repo.to_str().unwrap()).unwrap();
    let again = f.core.add_project(repo.to_str().unwrap()).unwrap();

    assert_eq!(first.name, "app");
    assert_eq!(again.id, first.id);
    assert_eq!(f.core.list_projects().unwrap().len(), 1);
}

#[test]
fn add_folder_expands_tilde_unhides_and_rejects_non_folders() {
    let f = fixture(vec![]);
    make_repo(&f.root().join("user/app"));

    let project = f.core.add_project("~/app").unwrap();
    f.core.set_project_hidden(project.id, true).unwrap();
    let again = f.core.add_project("~/app").unwrap();

    assert!(!again.hidden);
    assert!(f.core.add_project("~/nope").is_err());
}

#[test]
fn new_project_creates_a_folder_with_git_init() {
    let f = fixture(vec![]);
    let parent = f.root().join("code");
    std::fs::create_dir_all(&parent).unwrap();

    let project = f
        .core
        .create_project(parent.to_str().unwrap(), "fresh")
        .unwrap();

    assert_eq!(project.name, "fresh");
    assert!(parent.join("fresh/.git").is_dir());
}

#[test]
fn new_project_refuses_existing_folders_and_names_that_escape_the_parent() {
    let f = fixture(vec![]);
    let parent = f.root().join("code");
    std::fs::create_dir_all(parent.join("taken")).unwrap();
    let p = parent.to_str().unwrap();

    assert!(f.core.create_project(p, "taken").is_err());
    assert!(f.core.create_project(p, "").is_err());
    assert!(f.core.create_project(p, "../out").is_err());
    assert!(f.core.create_project(p, "a/b").is_err());
    assert!(f.core.list_projects().unwrap().is_empty());
}

#[test]
fn clone_from_url_registers_the_clone() {
    let f = fixture(vec![]);
    let origin = f.root().join("origin/widgets");
    make_repo(&origin);
    let parent = f.root().join("code");

    let project = f
        .core
        .clone_project(
            &format!("file://{}", origin.display()),
            parent.to_str().unwrap(),
        )
        .unwrap();

    assert_eq!(project.name, "widgets");
    assert!(parent.join("widgets/a.txt").is_file());
    assert_eq!(f.core.list_projects().unwrap().len(), 1);
}

#[test]
fn failed_clone_registers_nothing() {
    let f = fixture(vec![]);
    let parent = f.root().join("code");

    let err = f
        .core
        .clone_project("file:///does/not/exist.git", parent.to_str().unwrap());

    assert!(err.is_err());
    assert!(f.core.list_projects().unwrap().is_empty());
}

#[test]
fn github_search_filters_repositories_through_gh_and_clones_the_pick() {
    let f = fixture(vec![]);
    let origin = f.root().join("origin/gadgets");
    make_repo(&origin);
    install_gh(
        &f,
        serde_json::json!([
            {"nameWithOwner": "me/gadgets", "description": "Tiny tools", "isPrivate": false,
             "source": origin.to_str().unwrap()},
            {"nameWithOwner": "me/other", "description": "", "isPrivate": true, "source": "/x"},
        ]),
    );

    let hits = f.core.search_github_repositories("gadg").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name_with_owner, "me/gadgets");
    assert_eq!(f.core.search_github_repositories("").unwrap().len(), 2);

    let parent = f.root().join("code");
    let project = f
        .core
        .clone_github_repository("me/gadgets", parent.to_str().unwrap())
        .unwrap();
    assert_eq!(project.name, "gadgets");
    assert!(parent.join("gadgets/a.txt").is_file());
}

#[test]
fn github_search_without_gh_explains_how_to_get_it() {
    let f = fixture(vec![]);
    f.core.set_gh_search_path(Some(vec![]));
    let err = f.core.search_github_repositories("x").unwrap_err();
    assert!(err.to_string().contains("Install the GitHub CLI"));
}

#[test]
fn detects_only_installed_editors_from_the_known_list() {
    let f = fixture(vec![
        "dev.zed.Zed",
        "com.microsoft.VSCode",
        "not.in.the.list",
    ]);
    let ids: Vec<String> = f
        .core
        .detected_editors()
        .into_iter()
        .map(|e| e.bundle_id)
        .collect();
    assert_eq!(ids, ["com.microsoft.VSCode", "dev.zed.Zed"]);
}

#[test]
fn open_in_editor_uses_the_configured_editor_and_the_thread_checkout() {
    let f = fixture(vec!["dev.zed.Zed", "com.microsoft.VSCode"]);
    let repo = f.root().join("code/app");
    make_repo(&repo);
    let project = f.core.add_project(repo.to_str().unwrap()).unwrap();
    let thread = f
        .core
        .create_thread(project.id, "claude", None, None, None)
        .unwrap();

    let mut settings = f.core.settings().settings;
    settings.editor = "dev.zed.Zed".into();
    f.core.save_settings(&settings).unwrap();
    f.core.open_in_editor(project.id, Some(thread.id)).unwrap();

    let opened = f.system.opened.lock().unwrap().clone();
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0].0, "dev.zed.Zed");
    assert_eq!(opened[0].1, repo.canonicalize().unwrap());
}

#[test]
fn open_in_editor_falls_back_to_the_first_detected_and_errors_with_none() {
    let f = fixture(vec!["dev.zed.Zed"]);
    let repo = f.root().join("code/app");
    make_repo(&repo);
    let project = f.core.add_project(repo.to_str().unwrap()).unwrap();

    // The default Settings name no editor.
    f.core.open_in_editor(project.id, None).unwrap();
    assert_eq!(f.system.opened.lock().unwrap()[0].0, "dev.zed.Zed");

    let none = fixture(vec![]);
    let project = none.core.add_project(repo.to_str().unwrap()).unwrap();
    assert!(none.core.open_in_editor(project.id, None).is_err());
}

#[test]
fn reveal_in_finder_reveals_the_checkout() {
    let f = fixture(vec![]);
    let repo = f.root().join("code/app");
    make_repo(&repo);
    let project = f.core.add_project(repo.to_str().unwrap()).unwrap();

    f.core.reveal_in_finder(project.id, None).unwrap();

    assert_eq!(
        f.system.revealed.lock().unwrap().as_slice(),
        [repo.canonicalize().unwrap()]
    );
}

#[test]
fn scanned_projects_stay_closed_until_opened_and_closing_keeps_them_known() {
    let f = fixture(vec![]);
    make_repo(&f.root().join("user/Code/scanned"));
    make_repo(&f.root().join("user/Code/added"));

    let scanned = f.core.rescan_projects().unwrap();
    assert_eq!(scanned.len(), 2);
    assert!(
        scanned.iter().all(|p| !p.open),
        "a scan only makes Projects known"
    );

    let added = f
        .core
        .add_project(f.root().join("user/Code/added").to_str().unwrap())
        .unwrap();
    assert!(added.open, "adding a folder opens it");

    let other = scanned.iter().find(|p| p.name == "scanned").unwrap();
    f.core.remember_selection(other.id, None).unwrap();
    let open = |name: &str| {
        f.core
            .list_projects()
            .unwrap()
            .into_iter()
            .find(|p| p.name == name)
            .unwrap()
            .open
    };
    assert!(open("scanned"), "selecting a Project opens it");

    f.core.set_project_open(other.id, false).unwrap();
    assert!(!open("scanned"));
    f.core.rescan_projects().unwrap();
    assert!(!open("scanned"), "a rescan does not reopen it");
    assert_eq!(
        f.core.list_projects().unwrap().len(),
        2,
        "closing keeps the Project known"
    );
}
