//! Oxide Core: all application logic, with no dependency on Tauri.
//! The App shell exposes [`Core`] to the webview; tests drive it headless.

mod db;
mod discovery;
mod error;
mod settings;
mod storage_actor;
pub mod thread;
mod thread_actor;

use oxide_provider::Provider as ProviderTrait;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use storage_actor::StorageHandle;
use thread_actor::ThreadActorHandle;

use rusqlite::Connection;
use serde::Serialize;

pub use db::MIGRATIONS;
pub use error::{Error, Result};
pub use oxide_provider::{ItemKind, TurnStatus};
use settings::SettingsStore;
pub use settings::{
    FieldError, PermissionMode, Provider, ProviderSettings, Providers, Settings, SettingsState,
};
pub use thread::{
    ItemSnapshot, SequencedThreadEvent, ThreadEvent, ThreadSnapshot, ThreadStatus, ThreadSummary,
    TurnSnapshot,
};

const DB_FILE: &str = "oxide.db";

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
        })
    }

    pub fn set_real_time_ticker(&self, enabled: bool) {
        self.real_time_ticker.store(enabled, Ordering::Relaxed);
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

    pub fn create_thread(
        &self,
        project_id: u32,
        provider: &str,
        model: Option<String>,
        effort: Option<String>,
        permission_mode: PermissionMode,
    ) -> Result<ThreadSummary> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mode_str = serde_json::to_string(&permission_mode)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        db.execute(
            "INSERT INTO threads (project_id, provider, model, effort, permission_mode, status) VALUES (?1, ?2, ?3, ?4, ?5, 'completed')",
            rusqlite::params![project_id, provider, model, effort, mode_str],
        )?;
        let id = db.last_insert_rowid() as u32;
        self.get_thread_by_id(&db, id)
    }

    pub fn list_threads(&self, project_id: u32) -> Result<Vec<ThreadSummary>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare(
            "SELECT id, project_id, provider, model, effort, permission_mode, status, archived, created_at, updated_at
             FROM threads WHERE project_id = ?1 ORDER BY id DESC"
        )?;
        let rows = stmt.query_map([project_id], thread::parse_thread_summary)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn get_thread_by_id(&self, db: &Connection, id: u32) -> Result<ThreadSummary> {
        db.query_row(
            "SELECT id, project_id, provider, model, effort, permission_mode, status, archived, created_at, updated_at
             FROM threads WHERE id = ?1",
            [id],
            thread::parse_thread_summary,
        )
        .map_err(Into::into)
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

        let snapshot = self.storage.get_snapshot(thread_id)?;
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
            } else {
                Box::new(oxide_provider::FakeProvider::default())
            };

        let real_time = self.real_time_ticker.load(Ordering::Relaxed);
        let actor = ThreadActorHandle::new(
            thread_id,
            project_path,
            provider,
            self.storage.clone(),
            real_time,
        )?;

        actors.insert(thread_id, actor.clone());
        Ok(actor)
    }

    pub fn send_prompt(&self, thread_id: u32, prompt: &str) -> Result<()> {
        let actor = self.get_or_create_thread_actor(thread_id)?;
        actor.send_prompt(prompt.to_string())
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

    pub fn tick_thread(&self, thread_id: u32) {
        if let Some(actor) = self.thread_actors.lock().unwrap().get(&thread_id) {
            actor.tick();
        }
    }

    pub fn get_thread_snapshot(&self, thread_id: u32) -> Result<ThreadSnapshot> {
        self.storage.get_snapshot(thread_id)
    }

    fn expand_home(&self, root: &str) -> PathBuf {
        match root.strip_prefix("~") {
            Some("") => self.user_home.clone(),
            Some(rest) if rest.starts_with('/') => self.user_home.join(&rest[1..]),
            _ => PathBuf::from(root),
        }
    }
}
