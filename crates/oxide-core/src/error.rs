use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("I/O error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("database is at version {found}, newer than this build supports ({supported})")]
    DatabaseTooNew { found: u32, supported: u32 },
    #[error("terminal error: {0}")]
    Terminal(String),
}

pub type Result<T> = std::result::Result<T, Error>;
