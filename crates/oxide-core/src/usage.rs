//! Usage limits per Provider. A Usage limit belongs to the Provider's account, not to a Thread, so
//! every Thread of a Provider feeds and reads the same snapshot. Reports are merged window by
//! window and the latest snapshot is persisted so the ring has a value after a restart.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use oxide_provider::{UsageStatus, UsageWindow, UsageWindowKind};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One window of a Provider's Usage limits, with the time Oxide last heard about it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimitWindow {
    /// Share used, 0 to 100; `None` when the Provider reported a status without a figure.
    pub percent_used: Option<f64>,
    /// When the window resets, seconds since the Unix epoch (UTC).
    pub resets_at: Option<i64>,
    pub status: UsageStatus,
    /// When Oxide received this report, seconds since the Unix epoch (UTC).
    pub reported_at: i64,
}

/// The latest 5-hour and weekly Usage limits of one Provider.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub five_hour: Option<UsageLimitWindow>,
    pub weekly: Option<UsageLimitWindow>,
}

impl UsageLimits {
    fn merge(&mut self, windows: &[UsageWindow], reported_at: i64) {
        for w in windows {
            let slot = match w.kind {
                UsageWindowKind::FiveHour => &mut self.five_hour,
                UsageWindowKind::Weekly => &mut self.weekly,
            };
            // A status-only report keeps the last known figure and reset time.
            let previous = slot.take();
            *slot = Some(UsageLimitWindow {
                percent_used: w
                    .percent_used
                    .or_else(|| previous.as_ref().and_then(|p| p.percent_used)),
                resets_at: w
                    .resets_at
                    .or_else(|| previous.as_ref().and_then(|p| p.resets_at)),
                status: w.status,
                reported_at,
            });
        }
    }
}

/// What a Thread actor shares with the rest of Core: its status feed and the Usage limits of its
/// Provider.
pub struct ActorServices {
    pub activity: std::sync::Arc<crate::activity::Activity>,
    pub usage: std::sync::Arc<UsageHub>,
    /// The Provider key Usage limits are filed under.
    pub provider: String,
}

pub struct UsageHub {
    db_path: PathBuf,
    limits: Mutex<HashMap<String, UsageLimits>>,
    subscribers: Mutex<Vec<(String, crossbeam_channel::Sender<UsageLimits>)>>,
}

fn state_key(provider: &str) -> String {
    format!("usage_limits:{provider}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl UsageHub {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        let limits = load_all(&db_path).unwrap_or_default();
        Self {
            db_path,
            limits: Mutex::new(limits),
            subscribers: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn get(&self, provider: &str) -> Option<UsageLimits> {
        self.limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(provider)
            .cloned()
    }

    /// The current snapshot and a channel of the snapshots that follow.
    pub(crate) fn subscribe(
        &self,
        provider: &str,
    ) -> (
        Option<UsageLimits>,
        crossbeam_channel::Receiver<UsageLimits>,
    ) {
        let (tx, rx) = crossbeam_channel::unbounded();
        // Registering under the limits lock keeps a concurrent report from slipping between
        // the snapshot and the subscription.
        let limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((provider.to_string(), tx));
        (limits.get(provider).cloned(), rx)
    }

    /// Merges a Provider's report into its snapshot, persists it and tells subscribers.
    pub(crate) fn report(&self, provider: &str, windows: &[UsageWindow]) {
        if windows.is_empty() {
            return;
        }
        let snapshot = {
            let mut limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
            let entry = limits.entry(provider.to_string()).or_default();
            entry.merge(windows, now_secs());
            entry.clone()
        };
        self.persist(provider, &snapshot);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(p, tx)| p != provider || tx.send(snapshot.clone()).is_ok());
    }

    fn persist(&self, provider: &str, snapshot: &UsageLimits) {
        let Ok(value) = serde_json::to_string(snapshot) else {
            return;
        };
        if let Ok(conn) = Connection::open(&self.db_path) {
            let _ = conn.execute(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [state_key(provider), value],
            );
        }
    }
}

fn load_all(db_path: &PathBuf) -> rusqlite::Result<HashMap<String, UsageLimits>> {
    let conn = Connection::open(db_path)?;
    let mut stmt =
        conn.prepare("SELECT key, value FROM app_state WHERE key LIKE 'usage_limits:%'")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|(key, value)| {
            let provider = key.strip_prefix("usage_limits:")?.to_string();
            Some((provider, serde_json::from_str(&value).ok()?))
        })
        .collect())
}
