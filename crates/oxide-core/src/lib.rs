//! Oxide Core: all application logic, with no dependency on Tauri.
//! The App shell exposes [`Core`] to the webview; tests drive it headless.

mod db;
mod discovery;
mod error;
mod settings;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;

pub use db::MIGRATIONS;
pub use error::{Error, Result};
use settings::SettingsStore;
pub use settings::{
    FieldError, PermissionMode, Provider, ProviderSettings, Providers, Settings, SettingsState,
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
        Ok(Self {
            home,
            user_home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default(),
            db: Mutex::new(db),
            settings,
            _settings_watcher,
        })
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

    fn expand_home(&self, root: &str) -> PathBuf {
        match root.strip_prefix("~") {
            Some("") => self.user_home.clone(),
            Some(rest) if rest.starts_with('/') => self.user_home.join(&rest[1..]),
            _ => PathBuf::from(root),
        }
    }
}
