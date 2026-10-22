use oxide_provider::{ApprovalDecision, ApprovalKind, ItemKind, PermissionMode, TurnStatus};
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
    /// The Subagent Item this Item is nested under.
    pub parent_item_index: Option<u32>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalSnapshot {
    pub id: u32,
    pub turn_id: u32,
    pub approval_id: String,
    pub kind: ApprovalKind,
    pub summary: String,
    pub options: Vec<String>,
    pub decision: Option<ApprovalDecision>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownEventSnapshot {
    pub id: u32,
    pub raw: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Why the Turn failed; set only when `status` is error.
    pub error: Option<TurnError>,
    pub approvals: Vec<ApprovalSnapshot>,
    pub unknown_events: Vec<UnknownEventSnapshot>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCapabilities {
    pub reasoning_text: bool,
    pub image_attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnError {
    pub message: String,
    pub stderr_tail: Option<String>,
}

/// A Thread as of `last_seq`. `turns` holds the Turns at positions
/// `turn_offset..turn_count`, in order; earlier ones are paged in on demand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    pub thread: ThreadSummary,
    pub capabilities: ThreadCapabilities,
    pub turns: Vec<TurnSnapshot>,
    pub turn_offset: u32,
    pub turn_count: u32,
    pub last_seq: u32,
    pub supported_permission_modes: Vec<PermissionMode>,
}

/// The Turns at positions `offset..offset + turns.len()` of a Thread holding
/// `turn_count` Turns. A Turn's position is its place in the Thread, from 0.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnPage {
    pub offset: u32,
    pub turns: Vec<TurnSnapshot>,
    pub turn_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
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
        error: Option<TurnError>,
    },
    ThreadStatusChanged {
        status: ThreadStatus,
    },
    ApprovalRequested {
        id: String,
        kind: ApprovalKind,
        summary: String,
        options: Vec<String>,
    },
    ApprovalResponded {
        id: String,
        decision: ApprovalDecision,
        decided_at: String,
    },
    /// The Provider hit a transient failure and is retrying the Turn itself.
    ProviderRetrying {
        message: String,
    },
    Error {
        message: String,
    },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
}

/// A sequenced event on the debug subscriber channel, paired with the raw
/// Provider payload that produced it.  `raw_payload` is `None` only for
/// synthesised events (e.g. `ThreadStatusChanged`) that have no backing
/// Provider event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DebugSequencedThreadEvent {
    pub seq: u32,
    pub event: ThreadEvent,
    pub raw_payload: Option<String>,
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
