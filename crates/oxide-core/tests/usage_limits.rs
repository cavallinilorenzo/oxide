use std::time::{Duration, Instant};

use oxide_core::{Core, PermissionMode, UsageLimits, UsageStatus};
use oxide_provider::{FakeProvider, ProviderEvent, TurnStatus, UsageWindow, UsageWindowKind};
use tempfile::tempdir;

fn window(kind: UsageWindowKind, percent: Option<f64>, resets_at: Option<i64>) -> UsageWindow {
    UsageWindow {
        kind,
        percent_used: percent,
        resets_at,
        status: UsageStatus::Ok,
    }
}

/// A Fake Provider that reports `windows` and ends a Turn when prompted.
fn reporting(windows: Vec<UsageWindow>) -> FakeProvider {
    let fake = FakeProvider::default();
    let sender = fake.sender();
    fake.on_prompt(move |prompt| {
        let s = sender.clone();
        let prompt = prompt.to_string();
        let windows = windows.clone();
        std::thread::spawn(move || {
            let _ = s.send(ProviderEvent::TurnStarted {
                turn_index: 0,
                prompt,
            });
            let _ = s.send(ProviderEvent::UsageLimits { windows });
            let _ = s.send(ProviderEvent::TurnCompleted {
                turn_index: 0,
                status: TurnStatus::Completed,
            });
        });
    });
    fake
}

fn wait_for(core: &Core, provider: &str, ready: impl Fn(&UsageLimits) -> bool) -> UsageLimits {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(limits) = core.usage_limits(provider)
            && ready(&limits)
        {
            return limits;
        }
        assert!(Instant::now() < deadline, "usage limits never arrived");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn project(core: &Core, dir: &std::path::Path) -> u32 {
    let project_dir = dir.join("my-project");
    std::fs::create_dir_all(project_dir.join(".git")).unwrap();
    core.add_project(&project_dir.to_string_lossy()).unwrap().id
}

#[test]
fn threads_of_one_provider_share_merged_usage_limits_that_survive_a_restart() {
    let dir = tempdir().unwrap();
    {
        let core = Core::open(dir.path()).unwrap();
        core.set_real_time_ticker(false);
        let project_id = project(&core, dir.path());
        assert_eq!(core.usage_limits("fake"), None);
        let (initial, updates) = core.subscribe_usage_limits("fake");
        assert_eq!(initial, None);

        let first = core
            .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
            .unwrap();
        core.register_fake_provider(
            first.id,
            reporting(vec![window(
                UsageWindowKind::FiveHour,
                Some(40.0),
                Some(1_800_000_000),
            )]),
        );
        core.send_prompt(first.id, "go").unwrap();
        wait_for(&core, "fake", |l| l.five_hour.is_some());

        let second = core
            .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
            .unwrap();
        core.register_fake_provider(
            second.id,
            reporting(vec![window(UsageWindowKind::Weekly, Some(10.0), None)]),
        );
        core.send_prompt(second.id, "go").unwrap();
        let merged = wait_for(&core, "fake", |l| l.weekly.is_some());

        // The weekly report left the 5-hour figure in place.
        assert_eq!(merged.five_hour.as_ref().unwrap().percent_used, Some(40.0));
        assert_eq!(
            merged.five_hour.as_ref().unwrap().resets_at,
            Some(1_800_000_000)
        );
        assert_eq!(merged.weekly.as_ref().unwrap().percent_used, Some(10.0));
        assert!(merged.weekly.as_ref().unwrap().reported_at > 0);

        // The subscriber saw each report, the last one being the merged snapshot.
        let received: Vec<UsageLimits> = updates.try_iter().collect();
        assert_eq!(received.len(), 2);
        assert_eq!(received.last(), Some(&merged));

        // Other Providers are untouched.
        assert_eq!(core.usage_limits("codex"), None);
        core.shutdown();
    }

    let reopened = Core::open(dir.path()).unwrap();
    let restored = reopened.usage_limits("fake").expect("persisted");
    assert_eq!(restored.five_hour.unwrap().percent_used, Some(40.0));
    assert_eq!(restored.weekly.unwrap().percent_used, Some(10.0));
    let (current, _) = reopened.subscribe_usage_limits("fake");
    assert!(current.is_some());
}

#[test]
fn a_status_only_report_keeps_the_last_figure() {
    let dir = tempdir().unwrap();
    let core = Core::open(dir.path()).unwrap();
    core.set_real_time_ticker(false);
    let project_id = project(&core, dir.path());
    let thread = core
        .create_thread(project_id, "fake", None, None, PermissionMode::Ask)
        .unwrap();
    let mut limited = window(UsageWindowKind::FiveHour, None, None);
    limited.status = UsageStatus::Limited;
    core.register_fake_provider(
        thread.id,
        reporting(vec![
            window(UsageWindowKind::FiveHour, Some(70.0), Some(99)),
            limited,
        ]),
    );
    core.send_prompt(thread.id, "go").unwrap();
    let limits = wait_for(&core, "fake", |l| l.five_hour.is_some());
    let five = limits.five_hour.unwrap();
    assert_eq!(five.status, UsageStatus::Limited);
    assert_eq!(five.percent_used, Some(70.0));
    assert_eq!(five.resets_at, Some(99));
}
