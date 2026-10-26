use oxide_provider::{ProviderEvent, UsageStatus, UsageWindow, UsageWindowKind};
use serde_json::json;

fn windows(event: Option<ProviderEvent>) -> Vec<UsageWindow> {
    match event {
        Some(ProviderEvent::UsageLimits { windows }) => windows,
        other => panic!("expected UsageLimits, got {other:?}"),
    }
}

#[test]
fn claude_five_hour_event_with_utilization() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "resetsAt": 1_800_000_000,
            "rateLimitType": "five_hour",
            "utilization": 0.42
        }
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].kind, UsageWindowKind::FiveHour);
    assert!((w[0].percent_used.unwrap() - 42.0).abs() < 1e-9);
    assert_eq!(w[0].resets_at, Some(1_800_000_000));
    assert_eq!(w[0].status, UsageStatus::Ok);
}

#[test]
fn claude_missing_utilization_stays_unknown() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {"status": "allowed_warning", "resetsAt": 5, "rateLimitType": "seven_day"}
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w[0].kind, UsageWindowKind::Weekly);
    assert_eq!(w[0].percent_used, None);
    assert_eq!(w[0].status, UsageStatus::Warning);
}

#[test]
fn claude_rejected_status_is_limited() {
    let line = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour"}
    });
    let w = windows(oxide_provider::claude::parse_rate_limit_event(&line));
    assert_eq!(w[0].status, UsageStatus::Limited);
    assert_eq!(w[0].resets_at, None);
}

#[test]
fn claude_other_window_types_are_dropped() {
    for kind in [
        "seven_day_opus",
        "seven_day_sonnet",
        "seven_day_overage_included",
        "overage",
        "mystery",
    ] {
        let line = json!({
            "type": "rate_limit_event",
            "rate_limit_info": {"status": "allowed", "rateLimitType": kind, "utilization": 0.9}
        });
        assert_eq!(
            oxide_provider::claude::parse_rate_limit_event(&line),
            None,
            "{kind}"
        );
    }
}

#[test]
fn claude_malformed_event_yields_nothing() {
    assert_eq!(
        oxide_provider::claude::parse_rate_limit_event(&json!({"type": "rate_limit_event"})),
        None
    );
}

#[test]
fn codex_classifies_windows_by_duration_not_position() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 61, "windowDurationMins": 10080, "resetsAt": 200},
        "secondary": {"usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 100}
    }});
    let w = windows(oxide_provider::codex::parse_rate_limits(&params));
    let five = w
        .iter()
        .find(|w| w.kind == UsageWindowKind::FiveHour)
        .unwrap();
    let week = w
        .iter()
        .find(|w| w.kind == UsageWindowKind::Weekly)
        .unwrap();
    assert_eq!(five.percent_used, Some(12.5));
    assert_eq!(five.resets_at, Some(100));
    assert_eq!(week.percent_used, Some(61.0));
    assert_eq!(week.resets_at, Some(200));
    assert_eq!(five.status, UsageStatus::Ok);
}

#[test]
fn codex_status_follows_percent() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 85, "windowDurationMins": 300},
        "secondary": {"usedPercent": 100, "windowDurationMins": 10080}
    }});
    let w = windows(oxide_provider::codex::parse_rate_limits(&params));
    assert_eq!(w[0].status, UsageStatus::Warning);
    assert_eq!(w[1].status, UsageStatus::Limited);
}

#[test]
fn codex_unknown_durations_and_null_windows_are_dropped() {
    let params = json!({"rateLimits": {
        "primary": {"usedPercent": 10, "windowDurationMins": 60},
        "secondary": null
    }});
    assert_eq!(oxide_provider::codex::parse_rate_limits(&params), None);
    assert_eq!(oxide_provider::codex::parse_rate_limits(&json!({})), None);
}
