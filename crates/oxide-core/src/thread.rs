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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct ItemSnapshot {
    pub id: u32,
    pub item_index: u32,
    pub kind: ItemKind,
    pub content: String,
    /// The Subagent Item this Item is nested under.
    pub parent_item_index: Option<u32>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnSnapshot {
    pub id: u32,
    pub turn_index: u32,
    pub prompt: String,
    /// The Model and Effort the Turn ran with.
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Paths of image attachments, stored under the Oxide home.
    pub attachments: Vec<String>,
    pub status: TurnStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub items: Vec<ItemSnapshot>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadCapabilities {
    pub reasoning_text: bool,
    pub image_attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSnapshot {
    pub thread: ThreadSummary,
    pub capabilities: ThreadCapabilities,
    pub turns: Vec<TurnSnapshot>,
    pub last_seq: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThreadEvent {
    TurnStarted {
        turn_index: u32,
        prompt: String,
        model: Option<String>,
        effort: Option<String>,
        attachments: Vec<String>,
    },
    ItemStarted {
        item_index: u32,
        kind: ItemKind,
        parent_item_index: Option<u32>,
    },
    ItemDeltaBatch {
        item_index: u32,
        delta: String,
    },
    ItemCompleted {
        item_index: u32,
        kind: ItemKind,
        content: String,
        parent_item_index: Option<u32>,
    },
    TurnCompleted {
        turn_index: u32,
        status: TurnStatus,
    },
    ThreadStatusChanged {
        status: ThreadStatus,
    },
    ApprovalRequested {
        id: String,
        description: String,
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
