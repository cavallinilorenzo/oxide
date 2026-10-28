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
    #[error("path is outside the checkout: {0}")]
    InvalidPath(String),
    #[error("terminal error: {0}")]
    Terminal(String),
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Github(String),
    #[error("{0}")]
    Editor(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("{0}")]
    Attachment(#[from] crate::attachments::AttachmentError),
}

pub type Result<T> = std::result::Result<T, Error>;
