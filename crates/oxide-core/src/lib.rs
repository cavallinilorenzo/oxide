//! Oxide Core: all application logic, with no dependency on Tauri.
//! The App shell exposes [`Core`] to the webview; tests drive it headless.

mod db;
mod error;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub use db::MIGRATIONS;
pub use error::{Error, Result};

const DB_FILE: &str = "oxide.db";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: u32,
    pub name: String,
    pub path: String,
}

pub struct Core {
    home: PathBuf,
    db: Mutex<Connection>,
}

impl Core {
    /// Opens Oxide's home directory (creating it if needed) and its database.
    pub fn open(home: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_migrations(home, MIGRATIONS)
    }

    pub fn open_with_migrations(home: impl Into<PathBuf>, migrations: &[&str]) -> Result<Self> {
        let home = home.into();
        fs::create_dir_all(&home).map_err(|source| Error::Io {
            path: home.clone(),
            source,
        })?;
        let db = db::open(&home.join(DB_FILE), migrations)?;
        Ok(Self {
            home,
            db: Mutex::new(db),
        })
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// All Projects known to Oxide, most recently added first.
    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare("SELECT id, name, path FROM projects ORDER BY id DESC")?;
        let rows = stmt.query_map([], |r| {
            Ok(ProjectSummary {
                id: r.get(0)?,
                name: r.get(1)?,
                path: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
