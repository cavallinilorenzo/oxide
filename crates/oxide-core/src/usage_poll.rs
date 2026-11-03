//! Polls each Provider's account Usage limits on a timer, so the ring has a value without a running
//! Turn. The endpoints are undocumented and best-effort: a failure leaves the last snapshot alone.
//! See `docs/research/usage-quota-tracking.md`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use oxide_provider::{UsageStatus, UsageWindow, UsageWindowKind};
use serde_json::Value;

use crate::usage::UsageHub;

const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_TIMEOUT: Duration = Duration::from_secs(25);

fn status_for(percent: f64) -> UsageStatus {
    if percent >= 100.0 {
        UsageStatus::Limited
    } else if percent >= 80.0 {
        UsageStatus::Warning
    } else {
        UsageStatus::Ok
    }
}

fn window(kind: UsageWindowKind, percent: f64, resets_at: Option<i64>) -> UsageWindow {
    let percent = percent.clamp(0.0, 100.0);
    UsageWindow {
        kind,
        percent_used: Some(percent),
        resets_at,
        status: status_for(percent),
    }
}

/// RFC 3339 UTC timestamp (`2026-01-02T03:04:05[.fff]Z` or `+00:00`) to Unix seconds.
fn parse_rfc3339(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    let mut t = time.split(':').map(|p| p.parse::<i64>().ok());
    let (h, mi, sec) = (t.next()??, t.next()??, t.next().flatten().unwrap_or(0));
    let tail = &rest[time.len()..];
    let tail = tail.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let offset = match tail.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let (oh, om) = tail[1..].split_once(':').unwrap_or((&tail[1..], "0"));
            let secs = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
            if sign == '+' { secs } else { -secs }
        }
        _ => 0,
    };
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

// ---------- Claude ----------

/// `GET /api/oauth/usage`: `utilization` is already a 0-100 percent.
pub(crate) fn parse_claude_usage(body: &Value) -> Vec<UsageWindow> {
    [
        ("five_hour", UsageWindowKind::FiveHour),
        ("seven_day", UsageWindowKind::Weekly),
    ]
    .into_iter()
    .filter_map(|(key, kind)| {
        let w = body.get(key)?;
        let percent = w.get("utilization")?.as_f64()?;
        let resets = w
            .get("resets_at")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339);
        Some(window(kind, percent, resets))
    })
    .collect()
}

fn claude_token(user_home: &Path) -> Option<String> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".claude"));
    let raw = std::fs::read_to_string(dir.join(".credentials.json")).ok();
    #[cfg(target_os = "macos")]
    let raw = raw.or_else(|| {
        let out = Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-w",
            ])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    });
    let v: Value = serde_json::from_str(raw?.trim()).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_string)
}

fn http_get_json(url: &str, headers: &[(&str, String)]) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| e.to_string())
}

fn fetch_claude(user_home: &Path) -> Result<Vec<UsageWindow>, String> {
    let token = claude_token(user_home).ok_or("no Claude Code OAuth credentials")?;
    let body = http_get_json(
        "https://api.anthropic.com/api/oauth/usage",
        &[
            ("Authorization", format!("Bearer {token}")),
            ("anthropic-beta", "oauth-2025-04-20".into()),
            ("User-Agent", "claude-code/2.1.0".into()),
        ],
    )?;
    Ok(parse_claude_usage(&body))
}

// ---------- Codex ----------

/// Classifies a Codex window by its duration in minutes, not by its primary/secondary name.
fn codex_kind(minutes: i64) -> Option<UsageWindowKind> {
    match minutes {
        300 => Some(UsageWindowKind::FiveHour),
        10080 => Some(UsageWindowKind::Weekly),
        _ => None,
    }
}

/// `GET /backend-api/wham/usage`: `rate_limit.{primary,secondary}_window` with
/// `used_percent`, `limit_window_seconds` and `reset_at` (Unix seconds).
pub(crate) fn parse_codex_wham(body: &Value) -> Vec<UsageWindow> {
    let Some(limit) = body.get("rate_limit") else {
        return Vec::new();
    };
    ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|key| {
            let w = limit.get(key)?;
            let kind = codex_kind(w.get("limit_window_seconds")?.as_i64()? / 60)?;
            let percent = w.get("used_percent")?.as_f64()?;
            Some(window(
                kind,
                percent,
                w.get("reset_at").and_then(|v| v.as_i64()),
            ))
        })
        .collect()
}

fn fetch_codex(user_home: &Path) -> Result<Vec<UsageWindow>, String> {
    let dir = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".codex"));
    let raw = std::fs::read_to_string(dir.join("auth.json")).map_err(|e| e.to_string())?;
    let auth: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let tokens = auth.get("tokens").ok_or("no Codex ChatGPT login")?;
    let access = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("no Codex access token")?;
    let mut headers = vec![
        ("Authorization", format!("Bearer {access}")),
        ("User-Agent", "codex-cli".into()),
    ];
    if let Some(id) = tokens.get("account_id").and_then(|v| v.as_str()) {
        headers.push(("ChatGPT-Account-Id", id.to_string()));
    }
    let body = http_get_json("https://chatgpt.com/backend-api/wham/usage", &headers)?;
    Ok(parse_codex_wham(&body))
}

// ---------- Antigravity ----------

/// `agy -p /usage --output-format json`: `command.data.groups[].buckets[]` with
/// `remaining_fraction`, `window` (`5h` | `weekly`) and `reset_time`. When several groups report
/// the same window, the most used one wins.
pub(crate) fn parse_agy_usage(body: &Value) -> Vec<UsageWindow> {
    let mut out: Vec<UsageWindow> = Vec::new();
    let groups = body
        .pointer("/command/data/groups")
        .and_then(|g| g.as_array())
        .cloned()
        .unwrap_or_default();
    for bucket in groups
        .iter()
        .filter_map(|g| g.get("buckets")?.as_array())
        .flatten()
    {
        let kind = match bucket.get("window").and_then(|v| v.as_str()) {
            Some("5h") => UsageWindowKind::FiveHour,
            Some("weekly") => UsageWindowKind::Weekly,
            _ => continue,
        };
        let Some(remaining) = bucket.get("remaining_fraction").and_then(|v| v.as_f64()) else {
            continue;
        };
        let resets = bucket
            .get("reset_time")
            .and_then(|v| v.as_str())
            .and_then(parse_rfc3339);
        let w = window(kind, (1.0 - remaining) * 100.0, resets);
        match out.iter_mut().find(|e| e.kind == kind) {
            Some(e) if e.percent_used < w.percent_used => *e = w,
            Some(_) => {}
            None => out.push(w),
        }
    }
    out
}

fn fetch_agy() -> Result<Vec<UsageWindow>, String> {
    let mut cmd = Command::new("agy");
    cmd.args([
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--print-timeout",
        "20s",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    oxide_provider::process::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("cannot run agy: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("agy /usage timed out".into());
            }
        }
    }
    let text = reader.join().unwrap_or_default();
    let body: Value = serde_json::from_str(text.trim()).map_err(|e| e.to_string())?;
    // Older agy versions bill `/usage` as a model turn; never keep polling those.
    if body.get("command").is_none() {
        return Err("agy /usage ran as a model turn (needs agy >= 1.1.11)".into());
    }
    Ok(parse_agy_usage(&body))
}

pub(crate) struct PollerHandle {
    stop_tx: crossbeam_channel::Sender<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl PollerHandle {
    pub(crate) fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for PollerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts the background poller: once at startup, then every 15 minutes.
pub(crate) fn spawn(hub: Arc<UsageHub>, user_home: PathBuf) -> PollerHandle {
    let (stop_tx, stop_rx) = crossbeam_channel::bounded(1);
    let handle = std::thread::Builder::new()
        .name("usage-poll".into())
        .spawn(move || {
            let mut agy_enabled = true;
            loop {
                let mut jobs: Vec<(&str, Result<Vec<UsageWindow>, String>)> = vec![
                    ("claude", fetch_claude(&user_home)),
                    ("codex", fetch_codex(&user_home)),
                ];
                if agy_enabled {
                    let r = fetch_agy();
                    if matches!(&r, Err(e) if e.contains("model turn")) {
                        agy_enabled = false;
                    }
                    jobs.push(("agy", r));
                }
                for (provider, result) in jobs {
                    match result {
                        Ok(windows) => hub.report(provider, &windows),
                        Err(e) => eprintln!("usage poll ({provider}): {e}"),
                    }
                }
                match stop_rx.recv_timeout(POLL_INTERVAL) {
                    Ok(_) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                }
            }
        })
        .expect("failed to spawn usage-poll thread");
    PollerHandle {
        stop_tx,
        handle: Some(handle),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_percent_is_not_rescaled() {
        let w = parse_claude_usage(&json!({
            "five_hour": {"utilization": 42.5, "resets_at": "1970-01-02T00:00:00.123Z"},
            "seven_day": {"utilization": 100.0, "resets_at": null}
        }));
        assert_eq!(w[0].percent_used, Some(42.5));
        assert_eq!(w[0].resets_at, Some(86_400));
        assert_eq!(w[1].status, UsageStatus::Limited);
    }

    #[test]
    fn codex_wham_classifies_by_duration() {
        let w = parse_codex_wham(&json!({"rate_limit": {
            "primary_window": {"used_percent": 10.0, "limit_window_seconds": 18000, "reset_at": 5},
            "secondary_window": {"used_percent": 85.0, "limit_window_seconds": 604800, "reset_at": 9}
        }}));
        assert_eq!(w[0].kind, UsageWindowKind::FiveHour);
        assert_eq!(w[1].kind, UsageWindowKind::Weekly);
        assert_eq!(w[1].status, UsageStatus::Warning);
    }

    #[test]
    fn agy_buckets_take_most_used() {
        let w = parse_agy_usage(&json!({"command": {"data": {"groups": [
            {"buckets": [{"window": "5h", "remaining_fraction": 0.75, "reset_time": "1970-01-01T01:00:00Z"}]},
            {"buckets": [{"window": "5h", "remaining_fraction": 0.5},
                         {"window": "weekly", "remaining_fraction": 0.9}]}
        ]}}}));
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].percent_used, Some(50.0));
        assert!((w[1].percent_used.unwrap() - 10.0).abs() < 1e-9);
    }

    #[test]
    fn rfc3339_offsets() {
        assert_eq!(parse_rfc3339("1970-01-01T01:00:00+01:00"), Some(0));
    }

    #[test]
    fn poller_starts_and_stops_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Arc::new(UsageHub::new(dir.path().join("oxide.db")));
        let mut handle = spawn(hub, dir.path().to_path_buf());
        handle.stop();
    }
}
