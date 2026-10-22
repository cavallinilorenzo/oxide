use oxide_provider::{ItemKind, PermissionMode, TurnStatus};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThreadStatus {
    Working,
    NeedsInput,
    Completed,
    Error,
    Interrupted,
}

impl std::fmt::Display for ThreadStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ThreadStatus::Working => write!(f, "working"),
            ThreadStatus::NeedsInput => write!(f, "needs-input"),
            ThreadStatus::Completed => write!(f, "completed"),
            ThreadStatus::Error => write!(f, "error"),
            ThreadStatus::Interrupted => write!(f, "interrupted"),
        }
    }
}

impl std::str::FromStr for ThreadStatus {
    type Err = String;

    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "working" => Ok(ThreadStatus::Working),
            "needs-input" | "needs_input" => Ok(ThreadStatus::NeedsInput),
            "completed" => Ok(ThreadStatus::Completed),
            "error" => Ok(ThreadStatus::Error),
            "interrupted" => Ok(ThreadStatus::Interrupted),
            _ => Err(format!("unknown thread status: {s}")),
        }
    }
}

// The serde shapes below are the IPC shapes: the App shell's mirrors convert through JSON.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: u32,
    pub project_id: u32,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    pub status: ThreadStatus,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSnapshot {
    pub id: u32,
    pub item_index: u32,
    pub kind: ItemKind,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub id: u32,
    pub turn_index: u32,
    pub prompt: String,
    pub status: TurnStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub items: Vec<ItemSnapshot>,
    /// Why the Turn failed; set only when `status` is error.
    pub error: Option<TurnError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
    pub stderr_tail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread: ThreadSummary,
    pub turns: Vec<TurnSnapshot>,
    pub last_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ThreadEvent {
    TurnStarted {
        turn_index: u32,
        prompt: String,
    },
    ItemStarted {
        item_index: u32,
        kind: ItemKind,
    },
    ItemDeltaBatch {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
    },
    TurnCompleted {
        turn_index: u32,
        status: TurnStatus,
        error: Option<TurnError>,
    },
    ThreadStatusChanged {
        status: ThreadStatus,
    },
    ApprovalRequested {
        id: String,
        description: String,
    },
    /// The Provider hit a transient failure and is retrying the Turn itself.
    ProviderRetrying {
        message: String,
    },
    Error {
        message: String,
    },
    Unknown {
        raw: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
}

pub fn parse_thread_summary(r: &rusqlite::Row) -> rusqlite::Result<ThreadSummary> {
    let mode_str: String = r.get(5)?;
    let status_str: String = r.get(6)?;
    Ok(ThreadSummary {
        id: r.get(0)?,
        project_id: r.get(1)?,
        provider: r.get(2)?,
        model: r.get(3)?,
        effort: r.get(4)?,
        permission_mode: serde_json::from_value(serde_json::Value::String(mode_str))
            .unwrap_or(PermissionMode::AutoEdit),
        status: status_str.parse().unwrap_or(ThreadStatus::Completed),
        archived: r.get::<_, i64>(7)? != 0,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
    })
}
