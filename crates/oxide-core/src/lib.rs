//! Oxide Core: all application logic, with no dependency on Tauri.
//! The App shell exposes [`Core`] to the webview; tests drive it headless.

mod activity;
mod checkpoint;
mod clock;
mod continuation;
mod db;
mod discovery;
mod error;
mod files;
mod git;
mod git_diff;
mod github;
mod settings;
mod storage_actor;
mod terminal;
pub mod thread;
mod thread_actor;

pub use activity::{Notification, NotificationKind, System};
pub use continuation::{ContinuedThread, RECAP_MAX_CHARS};
pub use files::{FileContent, FileEntry};
pub use git::{FETCH_INTERVAL, GitBranch, GitStatus};
pub use git_diff::{Diff, DiffFile, DiffHunk, DiffKind, DiffLine, DiffScope, DiffStatus};
pub use github::{
    GithubAvailability, IssueComment, IssueDetail, IssueSummary, IssuesState, PullRequest,
    PullRequestDraft, PullRequestInput, PullRequestState,
};
use oxide_provider::Provider as ProviderTrait;
use oxide_provider::process::ProcessRegistry;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use storage_actor::StorageHandle;
pub use terminal::TerminalSummary;
use terminal::{TerminalSession, next_id};
use thread_actor::ThreadActorHandle;

use rusqlite::Connection;
use serde::Serialize;

pub use clock::{Clock, ManualClock, PROVIDER_IDLE_TIMEOUT, SystemClock};
pub use db::MIGRATIONS;
pub use error::{Error, Result};
pub use oxide_provider::{ApprovalDecision, ApprovalKind, Detection, ItemKind, TurnStatus};
use settings::SettingsStore;
pub use settings::{
    FieldError, PermissionMode, Provider, ProviderSettings, Providers, Settings, SettingsState,
};
pub use thread::{
    ApprovalSnapshot, DebugSequencedThreadEvent, ItemSnapshot, SequencedThreadEvent,
    ThreadCapabilities, ThreadEvent, ThreadSnapshot, ThreadStatus, ThreadSummary, TurnError,
    TurnPage, TurnSnapshot, UnknownEventSnapshot,
};

const DB_FILE: &str = "oxide.db";
const PROCESSES_FILE: &str = "processes.json";
static ATTACHMENT_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// How many of a Thread's most recent Turns it opens on; older Turns are paged
/// in with [`Core::list_turns`].
pub const SNAPSHOT_TURNS: u32 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectSummary {
    pub id: u32,
    pub name: String,
    pub path: String,
    /// Hidden from the sidebar; stays hidden across rescans.
    pub hidden: bool,
    /// The folder no longer exists; the record and its data are kept.
    pub missing: bool,
}

/// The Project and Thread Oxide reopens on launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Selection {
    pub project_id: u32,
    pub thread_id: Option<u32>,
}

/// How long quitting waits for interrupted Turns to wind down before killing their processes.
const QUIT_INTERRUPT_GRACE: Duration = Duration::from_secs(2);

pub struct Core {
    home: PathBuf,
    user_home: PathBuf,
    db: Mutex<Connection>,
    settings: Arc<SettingsStore>,
    _settings_watcher: notify::RecommendedWatcher,
    storage: StorageHandle,
    thread_actors: Mutex<HashMap<u32, ThreadActorHandle>>,
    fake_providers: Mutex<HashMap<u32, Box<dyn ProviderTrait>>>,
    real_time_ticker: AtomicBool,
    clock: Mutex<Arc<dyn Clock>>,
    processes: Arc<ProcessRegistry>,
    terminals: Mutex<HashMap<u32, Arc<TerminalSession>>>,
    next_terminal_id: AtomicU32,
    git: git::GitState,
    gh: github::Gh,
    activity: Arc<activity::Activity>,
}

impl Core {
    /// Opens Oxide's home directory (creating it if needed) and its database.
    pub fn open(home: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_migrations(home, MIGRATIONS)
    }

    /// Like [`Core::open`], with `~` in scan roots meaning `user_home`
    /// instead of `$HOME`.
    pub fn open_with_user_home(
        home: impl Into<PathBuf>,
        user_home: impl Into<PathBuf>,
    ) -> Result<Self> {
        let mut core = Self::open(home)?;
        core.user_home = user_home.into();
        Ok(core)
    }

    pub fn open_with_migrations(home: impl Into<PathBuf>, migrations: &[&str]) -> Result<Self> {
        let home = home.into();
        fs::create_dir_all(&home).map_err(|source| Error::Io {
            path: home.clone(),
            source,
        })?;
        let db = db::open(&home.join(DB_FILE), migrations)?;
        let (settings, _settings_watcher) = SettingsStore::open(&home)?;
        // A crashed run leaves its Provider and shell groups behind; its Threads were mid-flight.
        let processes = Arc::new(ProcessRegistry::open(home.join(PROCESSES_FILE)));
        processes.reap_stale();
        mark_unfinished_work_interrupted(&db)?;
        let storage = StorageHandle::new(home.join(DB_FILE))?;
        Ok(Self {
            home,
            user_home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default(),
            db: Mutex::new(db),
            settings,
            _settings_watcher,
            storage,
            thread_actors: Mutex::new(HashMap::new()),
            fake_providers: Mutex::new(HashMap::new()),
            real_time_ticker: AtomicBool::new(true),
            clock: Mutex::new(Arc::new(SystemClock)),
            processes,
            terminals: Mutex::new(HashMap::new()),
            next_terminal_id: AtomicU32::new(1),
            git: git::GitState::default(),
            gh: github::Gh::default(),
            activity: Arc::new(activity::Activity::new()),
        })
    }

    pub fn set_real_time_ticker(&self, enabled: bool) {
        self.real_time_ticker.store(enabled, Ordering::Relaxed);
    }

    /// Replaces the clock idle reaping reads. Call before the first Thread is used.
    pub fn set_clock(&self, clock: Arc<dyn Clock>) {
        *self.clock.lock().unwrap_or_else(|e| e.into_inner()) = clock;
    }

    /// Shuts every Provider and terminal down, escalating SIGTERM to SIGKILL, and returns once
    /// their processes are gone. Safe to call more than once; also runs when Core is dropped.
    pub fn shutdown(&self) {
        let actors: Vec<_> = self
            .thread_actors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, actor)| actor)
            .collect();
        // Shut them down side by side: each may wait out the 2 s grace.
        std::thread::scope(|scope| {
            for actor in &actors {
                scope.spawn(|| actor.shutdown());
            }
        });
        let terminals: Vec<_> = self
            .terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in terminals {
            session.close();
        }
    }

    /// Installs the operating-system side of Core's activity: the App Nap assertion
    /// (held while any Turn is working), notifications and the Dock badge.
    pub fn set_system(&self, system: Arc<dyn System>) {
        self.activity.set_system(system);
    }

    /// Tells Core whether the window is visible and focused. Notifications fire only when it is not.
    pub fn set_window_active(&self, active: bool) {
        self.activity.set_window_active(active);
    }

    /// How many Threads quitting would interrupt, when Oxide should ask first: some are
    /// working or need input and the quit-confirmation Setting is on.
    pub fn quit_confirmation(&self) -> Option<u32> {
        let active = self.activity.active_count();
        (active > 0 && self.settings().settings.confirm_quit).then_some(active)
    }

    /// Turns the quit-confirmation Setting off ("don't ask again").
    pub fn disable_quit_confirmation(&self) -> Result<()> {
        let mut settings = self.settings().settings;
        settings.confirm_quit = false;
        self.save_settings(&settings)
    }

    /// Interrupts every running Turn, then stops every Provider and shell. Returns once their
    /// processes are gone.
    pub fn quit(&self) {
        let actors: Vec<_> = self
            .thread_actors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for actor in &actors {
            let _ = actor.interrupt();
        }
        // The Providers report the interruption asynchronously; give them a moment to.
        let deadline = std::time::Instant::now() + QUIT_INTERRUPT_GRACE;
        while self.activity.active_count() > 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        self.shutdown();
    }

    /// Remembers the Project and Thread the user is looking at, to reopen on next launch.
    pub fn remember_selection(&self, project_id: u32, thread_id: Option<u32>) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "INSERT INTO app_state (key, value) VALUES ('selection', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [serde_json::to_string(&(project_id, thread_id)).unwrap_or_default()],
        )?;
        Ok(())
    }

    /// The Project and Thread last remembered, if they still exist.
    pub fn last_selection(&self) -> Result<Option<Selection>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let stored: Option<String> = db
            .query_row(
                "SELECT value FROM app_state WHERE key = 'selection'",
                [],
                |r| r.get(0),
            )
            .ok();
        let Some((project_id, thread_id)) =
            stored.and_then(|v| serde_json::from_str::<(u32, Option<u32>)>(&v).ok())
        else {
            return Ok(None);
        };
        let project_exists: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            [project_id],
            |r| r.get(0),
        )?;
        if !project_exists {
            return Ok(None);
        }
        let thread_id = match thread_id {
            Some(id) => db
                .query_row(
                    "SELECT EXISTS (SELECT 1 FROM threads WHERE id = ?1 AND project_id = ?2)",
                    [id, project_id],
                    |r| r.get::<_, bool>(0),
                )?
                .then_some(id),
            None => None,
        };
        Ok(Some(Selection {
            project_id,
            thread_id,
        }))
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// The Settings in effect, plus any validation errors in `settings.json`.
    pub fn settings(&self) -> SettingsState {
        self.settings.get()
    }

    /// Writes `settings.json` (pretty-printed) and applies it.
    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        self.settings.save(settings)
    }

    /// Calls `f` whenever the Settings state changes, whether through
    /// [`Core::save_settings`] or an edit of the file on disk.
    pub fn subscribe_settings(&self, f: impl Fn(&SettingsState) + Send + Sync + 'static) {
        self.settings.subscribe(Box::new(f));
    }

    /// All Projects known to Oxide, hidden and missing ones included, most
    /// recently added first.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt =
            db.prepare("SELECT id, name, path, hidden FROM projects ORDER BY id DESC")?;
        let rows = stmt.query_map([], |r| {
            let path: String = r.get(2)?;
            Ok(ProjectSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                missing: !Path::new(&path).exists(),
                path,
                hidden: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Scans the configured scan roots for Git repositories, records new ones
    /// as Projects (keyed by canonical path) and returns all Projects.
    /// Existing records, hidden or missing, are left untouched.
    pub fn rescan_projects(&self) -> Result<Vec<ProjectSummary>> {
        let roots: Vec<PathBuf> = self
            .settings()
            .settings
            .scan_roots
            .iter()
            .map(|r| self.expand_home(r))
            .collect();
        let found = discovery::find_repositories(&roots);
        {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let tx = db.unchecked_transaction()?;
            for path in &found {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                tx.execute(
                    "INSERT OR IGNORE INTO projects (name, path) VALUES (?1, ?2)",
                    (name, path.to_string_lossy()),
                )?;
            }
            tx.commit()?;
        }
        self.list_projects()
    }

    pub fn set_project_hidden(&self, id: u32, hidden: bool) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "UPDATE projects SET hidden = ?2 WHERE id = ?1",
            (id, hidden),
        )?;
        Ok(())
    }

    pub fn default_settings_for_provider(
        &self,
        provider: &str,
    ) -> (Option<String>, Option<String>, PermissionMode) {
        let settings = self.settings().settings;
        match provider {
            "claude" => (
                settings.providers.claude.model,
                settings.providers.claude.effort,
                settings.providers.claude.permission_mode,
            ),
            "codex" => (
                settings.providers.codex.model,
                settings.providers.codex.effort,
                settings.providers.codex.permission_mode,
            ),
            "agy" | "antigravity" => (
                settings.providers.antigravity.model,
                settings.providers.antigravity.effort,
                settings.providers.antigravity.permission_mode,
            ),
            _ => (None, None, PermissionMode::AutoEdit),
        }
    }

    pub fn default_permission_mode_for(&self, provider: &str) -> PermissionMode {
        self.default_settings_for_provider(provider).2
    }

    pub fn create_thread(
        &self,
        project_id: u32,
        provider: &str,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: impl Into<Option<PermissionMode>>,
    ) -> Result<ThreadSummary> {
        let (def_model, def_effort, def_perm) = self.default_settings_for_provider(provider);
        let model = model.or(def_model);
        let effort = effort.or(def_effort);
        let permission_mode = permission_mode.into().unwrap_or(def_perm);
        self.insert_thread(project_id, provider, model, effort, permission_mode, None)
    }

    /// Starts a new Thread that continues one whose Provider session is gone: same Project,
    /// Provider, Model, Effort and permission mode, linked both ways, with a recap of the old
    /// Transcript for the composer to prefill.
    pub fn continue_thread(&self, thread_id: u32) -> Result<ContinuedThread> {
        let old = self.storage.get_snapshot(thread_id, u32::MAX)?;
        let t = &old.thread;
        if !t.session_lost {
            return Err(Error::Provider(
                "only a Thread whose Provider session is gone can be continued".to_string(),
            ));
        }
        if t.continued_in.is_some() {
            return Err(Error::Provider(
                "this Thread has already been continued".to_string(),
            ));
        }
        let thread = self.insert_thread(
            t.project_id,
            &t.provider,
            t.model.clone(),
            t.effort.clone(),
            t.permission_mode,
            Some(thread_id),
        )?;
        Ok(ContinuedThread {
            thread,
            recap: continuation::build_recap(&old.turns),
        })
    }

    fn insert_thread(
        &self,
        project_id: u32,
        provider: &str,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: PermissionMode,
        continued_from: Option<u32>,
    ) -> Result<ThreadSummary> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mode_str = serde_json::to_string(&permission_mode)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        db.execute(
            "INSERT INTO threads (project_id, provider, model, effort, permission_mode, status, continued_from) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6)",
            rusqlite::params![project_id, provider, model, effort, mode_str, continued_from],
        )?;
        let id = db.last_insert_rowid() as u32;
        self.get_thread_by_id(&db, id)
    }

    pub fn set_thread_provider(&self, thread_id: u32, provider: &str) -> Result<ThreadSummary> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let (turn_count, status_str): (u32, String) = db.query_row(
            "SELECT (SELECT COUNT(*) FROM turns WHERE thread_id = ?1), status FROM threads WHERE id = ?1",
            [thread_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if turn_count > 0 || status_str == "working" {
            return Err(Error::Provider(
                "cannot switch provider after the first turn has started".into(),
            ));
        }

        let (def_model, def_effort, def_perm) = self.default_settings_for_provider(provider);
        let mode_str = serde_json::to_string(&def_perm)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();

        db.execute(
            "UPDATE threads SET provider = ?1, model = ?2, effort = ?3, permission_mode = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?5",
            rusqlite::params![provider, def_model, def_effort, mode_str, thread_id],
        )?;
        self.thread_actors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&thread_id);
        self.get_thread_by_id(&db, thread_id)
    }

    pub fn set_thread_permission_mode(&self, thread_id: u32, mode: PermissionMode) -> Result<()> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.set_permission_mode(mode)
    }

    pub fn respond_to_approval(
        &self,
        thread_id: u32,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<()> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.respond_to_approval(approval_id.to_string(), decision)
    }

    pub fn detect_provider(&self, provider: &str) -> oxide_provider::Detection {
        match provider {
            "claude" => oxide_provider::claude::ClaudeCodeProvider::new()
                .detect()
                .unwrap_or(oxide_provider::Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                }),
            "codex" => oxide_provider::codex::CodexProvider::new()
                .detect()
                .unwrap_or(oxide_provider::Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                }),
            "agy" | "antigravity" => oxide_provider::agy::AgyProvider::new().detect().unwrap_or(
                oxide_provider::Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                },
            ),
            "fake" => oxide_provider::Detection {
                available: true,
                installed: true,
                version: Some("0.1.0-fake".into()),
                authenticated: true,
                warning: None,
            },
            _ => oxide_provider::Detection {
                available: false,
                installed: false,
                version: None,
                authenticated: false,
                warning: Some(format!("Unknown provider '{provider}'")),
            },
        }
    }

    pub fn get_provider_capabilities(
        &self,
        provider: &str,
    ) -> oxide_provider::ProviderCapabilities {
        match provider {
            "claude" => oxide_provider::claude::ClaudeCodeProvider::new().capabilities(),
            "codex" => oxide_provider::codex::CodexProvider::new().capabilities(),
            "agy" | "antigravity" => oxide_provider::agy::AgyProvider::new().capabilities(),
            _ => oxide_provider::ProviderCapabilities {
                supported_permission_modes: vec![
                    PermissionMode::Ask,
                    PermissionMode::AutoEdit,
                    PermissionMode::FullAccess,
                ],
                interactive_approvals: true,
                supports_reasoning: true,
                image_attachments: false,
            },
        }
    }

    pub fn list_threads(&self, project_id: u32) -> Result<Vec<ThreadSummary>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(&format!(
            "SELECT {} FROM threads WHERE project_id = ?1 ORDER BY id DESC",
            thread::THREAD_COLUMNS
        ))?;
        let rows = stmt.query_map([project_id], thread::parse_thread_summary)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn get_thread_by_id(&self, db: &Connection, id: u32) -> Result<ThreadSummary> {
        db.query_row(
            &format!(
                "SELECT {} FROM threads WHERE id = ?1",
                thread::THREAD_COLUMNS
            ),
            [id],
            thread::parse_thread_summary,
        )
        .map_err(Into::into)
    }

    pub fn rename_thread(&self, thread_id: u32, title: &str) -> Result<()> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.execute(
            "UPDATE threads SET title = ?1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?2",
            rusqlite::params![title, thread_id],
        )?;
        drop(db);
        if let Some(actor) = self
            .thread_actors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&thread_id)
        {
            actor.rename(title.to_string());
        }
        Ok(())
    }

    pub fn register_fake_provider(&self, thread_id: u32, provider: impl ProviderTrait) {
        self.fake_providers
            .lock()
            .unwrap()
            .insert(thread_id, Box::new(provider));
    }

    pub fn get_or_create_thread_actor(&self, thread_id: u32) -> Result<ThreadActorHandle> {
        let mut actors = self.thread_actors.lock().unwrap();
        if let Some(actor) = actors.get(&thread_id) {
            return Ok(actor.clone());
        }

        let snapshot = self.storage.get_snapshot(thread_id, 0)?;
        let project_path = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let path_str: String = db.query_row(
                "SELECT path FROM projects WHERE id = ?1",
                [snapshot.thread.project_id],
                |r| r.get(0),
            )?;
            PathBuf::from(path_str)
        };

        let provider: Box<dyn ProviderTrait> =
            if let Some(p) = self.fake_providers.lock().unwrap().remove(&thread_id) {
                p
            } else if snapshot.thread.provider == "claude" {
                let mut claude = oxide_provider::claude::ClaudeCodeProvider::new();
                claude.set_registry(Arc::clone(&self.processes));
                let detection = claude.detect().unwrap_or(oxide_provider::Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                });
                if !detection.installed {
                    return Err(Error::Provider("Claude Code is not installed".to_string()));
                }
                Box::new(claude)
            } else if matches!(snapshot.thread.provider.as_str(), "agy" | "antigravity") {
                let mut agy = oxide_provider::agy::AgyProvider::new();
                agy.set_registry(Arc::clone(&self.processes));
                if !agy.detect().is_ok_and(|d| d.installed) {
                    return Err(Error::Provider(
                        "Antigravity CLI is not installed".to_string(),
                    ));
                }
                Box::new(agy)
            } else if snapshot.thread.provider == "codex" {
                let codex = oxide_provider::codex::CodexProvider::new();
                let detection = codex.detect().unwrap_or(oxide_provider::Detection {
                    available: false,
                    installed: false,
                    version: None,
                    authenticated: false,
                    warning: None,
                });
                if !detection.installed {
                    return Err(Error::Provider("Codex is not installed".to_string()));
                }
                Box::new(codex)
            } else {
                Box::new(oxide_provider::FakeProvider::scripted())
            };

        let real_time = self.real_time_ticker.load(Ordering::Relaxed);
        let actor = ThreadActorHandle::new(
            thread_id,
            project_path,
            provider,
            self.storage.clone(),
            real_time,
            self.clock.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            Arc::clone(&self.activity),
        )?;

        actors.insert(thread_id, actor.clone());
        Ok(actor)
    }

    pub fn send_prompt(&self, thread_id: u32, prompt: &str) -> Result<()> {
        self.send_prompt_with_attachments(thread_id, prompt, &[])
    }

    /// Sends a prompt with image attachments previously stored by [`Core::save_attachment`].
    /// Fails if the Provider doesn't accept images or a path is outside the attachments folder.
    pub fn send_prompt_with_attachments(
        &self,
        thread_id: u32,
        prompt: &str,
        attachments: &[PathBuf],
    ) -> Result<()> {
        if let Some(bad) = attachments.iter().find(|p| !self.is_stored_attachment(p)) {
            return Err(Error::Io {
                path: bad.clone(),
                source: std::io::Error::other("attachment is not stored under the Oxide home"),
            });
        }
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.send_prompt(prompt.to_string(), attachments.to_vec())
    }

    /// Reads a stored attachment; refuses paths outside the attachments folder.
    pub fn read_attachment(&self, path: &Path) -> Result<Vec<u8>> {
        let io = |source| Error::Io {
            path: path.to_path_buf(),
            source,
        };
        if !self.is_stored_attachment(path) {
            return Err(io(std::io::Error::other("not stored under the Oxide home")));
        }
        fs::read(path).map_err(io)
    }

    /// Whether `path` resolves (symlinks and `..` included) to a file inside the attachments folder.
    fn is_stored_attachment(&self, path: &Path) -> bool {
        match (path.canonicalize(), self.attachments_dir().canonicalize()) {
            (Ok(path), Ok(dir)) => path.starts_with(dir),
            _ => false,
        }
    }

    /// Capabilities of a Provider, before any Thread of it exists.
    pub fn provider_capabilities(&self, provider: &str) -> ThreadCapabilities {
        let caps = self.get_provider_capabilities(provider);
        ThreadCapabilities {
            reasoning_text: caps.supports_reasoning,
            image_attachments: caps.image_attachments,
        }
    }

    fn attachments_dir(&self) -> PathBuf {
        self.home.join("attachments")
    }

    /// Stores an image under `<home>/attachments/` and returns its path.
    pub fn save_attachment(&self, bytes: &[u8], extension: &str) -> Result<PathBuf> {
        const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
        let ext = extension.to_ascii_lowercase();
        let dir = self.attachments_dir();
        if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            return Err(Error::Io {
                path: dir,
                source: std::io::Error::other(format!("unsupported image type `{extension}`")),
            });
        }
        fs::create_dir_all(&dir).map_err(|source| Error::Io {
            path: dir.clone(),
            source,
        })?;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let seq = ATTACHMENT_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("{nanos}-{seq}.{ext}"));
        fs::write(&path, bytes).map_err(|source| Error::Io {
            path: path.clone(),
            source,
        })?;
        Ok(path)
    }

    pub fn interrupt_thread(&self, thread_id: u32) -> Result<()> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.interrupt()
    }

    pub fn subscribe_thread(
        &self,
        thread_id: u32,
    ) -> Result<(
        ThreadSnapshot,
        crossbeam_channel::Receiver<SequencedThreadEvent>,
    )> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.subscribe()
    }

    /// Like [`subscribe_thread`] but returns a debug channel where each event
    /// is paired with the raw Provider payload that produced it.  Only open
    /// this when the debug view is visible; raw payloads are never sent when
    /// no debug subscriber is registered.
    pub fn subscribe_thread_debug(
        &self,
        thread_id: u32,
    ) -> Result<(
        ThreadSnapshot,
        crossbeam_channel::Receiver<DebugSequencedThreadEvent>,
    )> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.subscribe_debug()
    }

    /// Starts a shell PTY in the Project's checkout. A terminal actor owns the
    /// PTY process until it is explicitly closed or Core shuts down.
    pub fn start_terminal(
        &self,
        project_id: u32,
        thread_id: Option<u32>,
    ) -> Result<TerminalSummary> {
        let cwd = self.checkout_path(project_id, thread_id)?;
        let id = next_id(&self.next_terminal_id);
        let session = Arc::new(TerminalSession::start(
            id,
            Path::new(&cwd),
            Arc::clone(&self.processes),
        )?);
        let summary = session.summary.clone();
        self.terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, session);
        Ok(summary)
    }

    /// The children of one directory of a Thread's checkout (`""` is the
    /// root), without `.git` or gitignored entries.
    pub fn list_dir(
        &self,
        project_id: u32,
        thread_id: Option<u32>,
        path: &str,
    ) -> Result<Vec<FileEntry>> {
        files::list_dir(Path::new(&self.checkout_path(project_id, thread_id)?), path)
    }

    /// A file of a Thread's checkout, read by Core so the webview never
    /// touches the filesystem. Capped at 1 MiB.
    pub fn read_file(
        &self,
        project_id: u32,
        thread_id: Option<u32>,
        path: &str,
    ) -> Result<FileContent> {
        files::read_file(Path::new(&self.checkout_path(project_id, thread_id)?), path)
    }

    /// Branch, ahead/behind and uncommitted-change counts of a Project's main checkout.
    pub fn git_status(&self, project_id: u32) -> Result<GitStatus> {
        let mut status = git::status(&self.main_checkout(project_id)?)?;
        status.picker_disabled_reason = self.checkout_blocked_reason(project_id)?;
        Ok(status)
    }

    /// The changes of a Project's main checkout in one scope, straight from Git.
    pub fn diff(&self, project_id: u32, scope: DiffScope) -> Result<Diff> {
        git_diff::diff(&self.main_checkout(project_id)?, scope)
    }

    /// What one Turn changed: the diff between its two Checkpoints.
    pub fn turn_diff(&self, thread_id: u32, turn_index: u32) -> Result<Diff> {
        let project_id = self.storage.get_snapshot(thread_id, 0)?.thread.project_id;
        checkpoint::turn_diff(&self.main_checkout(project_id)?, thread_id, turn_index)
    }

    /// [`Core::turn_diff`] of the Thread's latest Turn; empty before the first.
    pub fn latest_turn_diff(&self, thread_id: u32) -> Result<Diff> {
        let snapshot = self.storage.get_snapshot(thread_id, 0)?;
        match snapshot.turn_count.checked_sub(1) {
            Some(latest) => {
                let cwd = self.main_checkout(snapshot.thread.project_id)?;
                checkpoint::turn_diff(&cwd, thread_id, latest)
            }
            None => Ok(Diff {
                base: None,
                files: Vec::new(),
            }),
        }
    }

    /// Local and remote branches of a Project's main checkout.
    pub fn list_branches(&self, project_id: u32) -> Result<Vec<GitBranch>> {
        git::list_branches(&self.main_checkout(project_id)?)
    }

    /// Checks out a branch (`feature`, or `origin/feature` to track a remote
    /// one). Git's own refusal, e.g. for uncommitted changes, is the error.
    pub fn checkout_branch(&self, project_id: u32, name: &str) -> Result<()> {
        self.switch_branch(project_id, |cwd| git::checkout(cwd, name))
    }

    /// Creates a branch from HEAD and checks it out.
    pub fn create_branch(&self, project_id: u32, name: &str) -> Result<()> {
        self.switch_branch(project_id, |cwd| git::create_branch(cwd, name))
    }

    /// `git fetch`, skipped when the last one was under [`FETCH_INTERVAL`] ago.
    /// Returns whether it fetched.
    pub fn fetch_project(&self, project_id: u32) -> Result<bool> {
        self.fetch_project_at(project_id, std::time::Instant::now())
    }

    /// Like [`Core::fetch_project`], with the current time injected.
    pub fn fetch_project_at(&self, project_id: u32, now: std::time::Instant) -> Result<bool> {
        self.git.fetch(&self.main_checkout(project_id)?, now)
    }

    /// `git pull --ff-only`; a diverged branch fails with Git's message.
    pub fn pull(&self, project_id: u32) -> Result<()> {
        // Pulling rewrites files like a checkout does, so it takes the same guard.
        self.switch_branch(project_id, git::pull)
    }

    /// Commits exactly the given files of the main checkout with `message`,
    /// leaving other staged state alone.
    pub fn commit(&self, project_id: u32, paths: &[String], message: &str) -> Result<()> {
        let cwd = self.main_checkout(project_id)?;
        self.git.mutate(&cwd, || git::commit(&cwd, paths, message))
    }

    /// Pushes the current branch (upstream set on the first push, never
    /// forced). Pushing `main`/`master` needs `allow_protected`.
    pub fn push(&self, project_id: u32, allow_protected: bool) -> Result<()> {
        let cwd = self.main_checkout(project_id)?;
        self.git.mutate(&cwd, || git::push(&cwd, allow_protected))
    }

    /// Replaces the directories `gh` is looked up in (default: the process PATH
    /// plus Homebrew's). Tests put a fake `gh` alone on it.
    pub fn set_gh_search_path(&self, dirs: Option<Vec<PathBuf>>) {
        self.gh.set_search_path(dirs);
    }

    /// Whether `gh` works, and the branch's open pull request when it does.
    /// Runs `gh` only when called: the Surface refreshes it, Core never polls.
    pub fn pull_request_state(&self, project_id: u32) -> Result<PullRequestState> {
        github::pull_request_state(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Title, body and base prefilled for a new pull request of the current branch.
    pub fn pull_request_draft(&self, project_id: u32) -> Result<PullRequestDraft> {
        github::pull_request_draft(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Pushes the current branch if needed, then opens a pull request for it.
    pub fn create_pull_request(
        &self,
        project_id: u32,
        input: &PullRequestInput,
    ) -> Result<PullRequest> {
        let cwd = self.main_checkout(project_id)?;
        self.git
            .mutate(&cwd, || github::create_pull_request(&self.gh, &cwd, input))
    }

    /// Availability of GitHub CLI for issues, and guidance if missing/logged out.
    pub fn issues_state(&self, project_id: u32) -> Result<IssuesState> {
        github::issues_state(&self.gh, &self.main_checkout(project_id)?)
    }

    /// Open issues of the repository, optionally narrowed by a search query.
    pub fn list_issues(&self, project_id: u32, search: &str) -> Result<Vec<IssueSummary>> {
        github::list_issues(&self.gh, &self.main_checkout(project_id)?, search)
    }

    /// Detailed issue with its description, status and comments.
    pub fn issue_detail(&self, project_id: u32, number: u32) -> Result<IssueDetail> {
        github::issue_detail(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// Creates an issue with title and body.
    pub fn create_issue(&self, project_id: u32, title: &str, body: &str) -> Result<IssueSummary> {
        github::create_issue(&self.gh, &self.main_checkout(project_id)?, title, body)
    }

    /// Adds a comment to an issue.
    pub fn comment_issue(&self, project_id: u32, number: u32, body: &str) -> Result<()> {
        github::comment_issue(&self.gh, &self.main_checkout(project_id)?, number, body)
    }

    /// Closes an issue.
    pub fn close_issue(&self, project_id: u32, number: u32) -> Result<()> {
        github::close_issue(&self.gh, &self.main_checkout(project_id)?, number)
    }

    /// Opens an issue in the system browser.
    pub fn open_issue(&self, project_id: u32, number: u32) -> Result<()> {
        let url = github::issue_url(&self.gh, &self.main_checkout(project_id)?, number)?;
        self.activity.open_url(&url);
        Ok(())
    }

    pub fn open_pull_request(&self, project_id: u32) -> Result<()> {
        let url = github::pull_request_url(&self.gh, &self.main_checkout(project_id)?)?;
        self.activity.open_url(&url);
        Ok(())
    }

    /// Runs a command that changes the main checkout's files, serialized per
    /// checkout and refused while a Thread is working in it.
    fn switch_branch(&self, project_id: u32, f: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
        let cwd = self.main_checkout(project_id)?;
        self.git.mutate(&cwd, || {
            if let Some(reason) = self.checkout_blocked_reason(project_id)? {
                return Err(Error::Git(reason));
            }
            f(&cwd)
        })
    }

    /// Threads work in the main checkout, so switching branches under a
    /// running Turn would change its files.
    fn checkout_blocked_reason(&self, project_id: u32) -> Result<Option<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let working: u32 = db.query_row(
            "SELECT COUNT(*) FROM threads WHERE project_id = ?1 AND status = 'working'",
            [project_id],
            |r| r.get(0),
        )?;
        Ok((working > 0).then(|| {
            "A Thread is working in this checkout. Wait for its Turn to finish or stop it.".into()
        }))
    }

    fn main_checkout(&self, project_id: u32) -> Result<PathBuf> {
        Ok(PathBuf::from(self.checkout_path(project_id, None)?))
    }

    fn checkout_path(&self, project_id: u32, thread_id: Option<u32>) -> Result<String> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(match thread_id {
            Some(thread_id) => db.query_row(
                "SELECT p.path FROM projects p JOIN threads t ON t.project_id = p.id WHERE p.id = ?1 AND t.id = ?2",
                rusqlite::params![project_id, thread_id],
                |r| r.get(0),
            )?,
            None => db.query_row("SELECT path FROM projects WHERE id = ?1", [project_id], |r| r.get(0))?,
        })
    }

    pub fn subscribe_terminal(
        &self,
        terminal_id: u32,
    ) -> Result<crossbeam_channel::Receiver<Vec<u8>>> {
        Ok(self.terminal(terminal_id)?.subscribe())
    }

    pub fn write_terminal(&self, terminal_id: u32, bytes: &[u8]) -> Result<()> {
        self.terminal(terminal_id)?.write(bytes)
    }

    pub fn resize_terminal(&self, terminal_id: u32, rows: u16, cols: u16) -> Result<()> {
        self.terminal(terminal_id)?.resize(rows, cols)
    }

    pub fn close_terminal(&self, terminal_id: u32) -> Result<()> {
        let session = self
            .terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&terminal_id)
            .ok_or_else(|| Error::Terminal(format!("unknown terminal {terminal_id}")))?;
        session.close();
        Ok(())
    }

    fn terminal(&self, id: u32) -> Result<Arc<TerminalSession>> {
        self.terminals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::Terminal(format!("unknown terminal {id}")))
    }

    pub fn tick_thread(&self, thread_id: u32) {
        if let Some(actor) = self.thread_actors.lock().unwrap().get(&thread_id) {
            actor.tick();
        }
    }

    /// The whole Thread, every Turn included.
    pub fn get_thread_snapshot(&self, thread_id: u32) -> Result<ThreadSnapshot> {
        let mut snapshot = self.storage.get_snapshot(thread_id, u32::MAX)?;
        for turn in &mut snapshot.turns {
            turn.unknown_events.clear();
        }
        Ok(snapshot)
    }

    /// Up to `limit` Turns of a Thread starting at position `offset`.
    pub fn list_turns(&self, thread_id: u32, offset: u32, limit: u32) -> Result<TurnPage> {
        let mut page = self.storage.list_turns(thread_id, offset, limit)?;
        for turn in &mut page.turns {
            turn.unknown_events.clear();
        }
        Ok(page)
    }

    fn expand_home(&self, root: &str) -> PathBuf {
        match root.strip_prefix("~") {
            Some("") => self.user_home.clone(),
            Some(rest) if rest.starts_with('/') => self.user_home.join(&rest[1..]),
            _ => PathBuf::from(root),
        }
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Threads that were working or waiting for input when Oxide last went away show as
/// interrupted, along with their running Turn and unanswered Approvals. Nothing restarts.
fn mark_unfinished_work_interrupted(db: &Connection) -> Result<()> {
    let has_threads: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads')",
        [],
        |r| r.get(0),
    )?;
    if !has_threads {
        return Ok(());
    }
    db.execute_batch(
        "UPDATE approvals SET decision = 'deny', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE decision IS NULL
               AND turn_id IN (SELECT id FROM turns WHERE status = 'running');
         UPDATE turns SET status = 'interrupted', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE status = 'running';
         UPDATE threads SET status = 'interrupted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE status IN ('working', 'needs-input', 'needs_input');",
    )?;
    Ok(())
}
