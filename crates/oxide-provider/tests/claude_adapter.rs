#![cfg(unix)]

use oxide_provider::Provider;
use oxide_provider::claude::{ClaudeCodeProvider, ClaudeCustomizations};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

fn make_fake_cli(dir: &std::path::Path, version: &str, logged_in: bool) -> PathBuf {
    let script_path = dir.join("fake-claude.sh");
    let auth_exit = if logged_in { 0 } else { 1 };
    let content = format!(
        r#"#!/bin/sh
if [ "$1" = "--version" ]; then
    echo "claude {version}"
    exit 0
elif [ "$1" = "auth" ] && [ "$2" = "status" ]; then
    if [ {auth_exit} -eq 0 ]; then
        echo '{{"loggedIn": true}}'
        exit 0
    else
        echo '{{"loggedIn": false}}'
        exit 1
    fi
fi
exit 0
"#
    );
    fs::write(&script_path, content).unwrap();
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();
    script_path
}

#[test]
fn claude_detect_missing_cli() {
    let provider = ClaudeCodeProvider::with_command("nonexistent_binary_xyz_123");
    let detection = provider
        .detect()
        .expect("detect should not error on missing binary");
    assert!(!detection.installed);
    assert!(!detection.authenticated);
    assert!(!detection.available);
    assert_eq!(detection.version, None);
    assert_eq!(detection.warning, None);
}

#[test]
fn claude_detect_installed_and_authenticated_pinned_version() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "1.0.0", true);

    let provider = ClaudeCodeProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(detection.authenticated);
    assert!(detection.available);
    assert_eq!(detection.version.as_deref(), Some("1.0.0"));
    assert_eq!(detection.warning, None);
}

#[test]
fn claude_detect_installed_outside_pinned_range_gives_warning_not_block() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "3.5.0", true);

    let provider = ClaudeCodeProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(detection.authenticated);
    assert!(
        detection.available,
        "out-of-range version should warn, not block"
    );
    assert_eq!(detection.version.as_deref(), Some("3.5.0"));
    assert!(
        detection.warning.is_some(),
        "detection warning should be present when version is outside pinned range"
    );
    let warning = detection.warning.unwrap();
    assert!(warning.contains("3.5.0"));
}

#[test]
fn claude_detect_installed_but_logged_out() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "1.0.0", false);

    let provider = ClaudeCodeProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(!detection.authenticated);
    assert!(!detection.available);
    assert_eq!(detection.version.as_deref(), Some("1.0.0"));
    assert_eq!(detection.warning, None);
}

#[test]
fn claude_provider_runs_against_fake_cli_replaying_stream_json() {
    use oxide_provider::{ItemKind, PermissionMode, ProviderEvent, StartContext, TurnStatus};
    use std::time::Duration;

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");

    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: Some("claude-3-7-sonnet".into()),
        effort: Some("high".into()),
        permission_mode: PermissionMode::AutoEdit,
    };

    let rx = provider.start(&context).expect("start should succeed");

    provider
        .send_prompt("Hello test")
        .expect("send_prompt should succeed");

    let mut session_info_seen = false;
    let mut turn_started_seen = false;
    let mut item_started_seen = false;
    let mut item_deltas = Vec::new();
    let mut item_completed_seen = false;
    let mut unknown_seen = false;
    let mut turn_completed_seen = false;

    let timeout = Duration::from_secs(5);
    while let Ok(evt) = rx.recv_timeout(timeout) {
        match evt {
            ProviderEvent::SessionInfo { session_id } => {
                assert_eq!(session_id, "claude-session-1234");
                session_info_seen = true;
            }
            ProviderEvent::TurnStarted { turn_index, prompt } => {
                assert_eq!(turn_index, 0);
                assert_eq!(prompt, "Hello test");
                turn_started_seen = true;
            }
            ProviderEvent::ItemStarted {
                item_index, kind, ..
            } => {
                assert_eq!(item_index, 0);
                assert_eq!(kind, ItemKind::AgentMessage);
                item_started_seen = true;
            }
            ProviderEvent::ItemDelta { item_index, delta } => {
                assert_eq!(item_index, 0);
                item_deltas.push(delta);
            }
            ProviderEvent::ItemCompleted {
                item_index,
                kind,
                content,
                ..
            } => {
                assert_eq!(item_index, 0);
                assert_eq!(kind, ItemKind::AgentMessage);
                assert_eq!(content, "Hello world!");
                item_completed_seen = true;
            }
            ProviderEvent::Unknown { raw } => {
                assert!(raw.contains("custom_unrecognized_event"));
                unknown_seen = true;
            }
            ProviderEvent::TurnCompleted { turn_index, status } => {
                assert_eq!(turn_index, 0);
                assert_eq!(status, TurnStatus::Completed);
                turn_completed_seen = true;
                break;
            }
            _ => {}
        }
    }

    assert!(session_info_seen, "session info should be received");
    assert!(turn_started_seen, "turn started should be received");
    assert!(item_started_seen, "item started should be received");
    assert_eq!(item_deltas.concat(), "Hello world!");
    assert!(item_completed_seen, "item completed should be received");
    assert!(unknown_seen, "unknown events should be passed through");
    assert!(turn_completed_seen, "turn completed should be received");

    provider.shutdown().expect("shutdown should succeed");
}

#[test]
fn claude_provider_handles_wire_commands_and_approval() {
    use oxide_provider::{
        ApprovalDecision, ApprovalKind, PermissionMode, ProviderEvent, StartContext, TurnStatus,
    };
    use std::time::Duration;

    let wire_log = tempfile::NamedTempFile::new().unwrap();
    let wire_log_path = wire_log.path().to_str().unwrap().to_string();

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");

    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    provider.set_env("OXIDE_WIRE_LOG", &wire_log_path);

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: Some("opus".into()),
        effort: Some("low".into()),
        permission_mode: PermissionMode::Ask,
    };

    let rx = provider.start(&context).expect("start should succeed");

    // Test wire commands for model & permission mode
    provider.set_model("sonnet").unwrap();
    provider
        .set_permission_mode(PermissionMode::FullAccess)
        .unwrap();

    // Trigger approval test
    provider.send_prompt("approval_test").unwrap();

    let mut approval_requested_seen = false;
    let timeout = Duration::from_secs(5);

    while let Ok(evt) = rx.recv_timeout(timeout) {
        match evt {
            ProviderEvent::ApprovalRequested {
                id,
                kind,
                summary,
                options,
            } => {
                assert_eq!(id, "appr-42");
                assert_eq!(kind, ApprovalKind::Command);
                assert_eq!(summary, "Run cargo test");
                assert_eq!(options, vec!["allow-once", "allow-always"]);
                approval_requested_seen = true;

                // Respond to approval
                provider
                    .respond_to_approval(&id, ApprovalDecision::Allow)
                    .unwrap();
            }
            ProviderEvent::TurnCompleted { status, .. } => {
                assert_eq!(status, TurnStatus::Completed);
                break;
            }
            _ => {}
        }
    }

    assert!(approval_requested_seen, "approval request should be seen");

    // Read wire log
    let wire_contents = std::fs::read_to_string(&wire_log_path).unwrap();
    assert!(wire_contents.contains("opus"));
    assert!(wire_contents.contains("model_changed"));
    assert!(wire_contents.contains("sonnet"));
    assert!(wire_contents.contains("permission_mode_changed"));
    assert!(wire_contents.contains("approval_answered"));

    provider.shutdown().unwrap();
}

#[test]
fn claude_provider_handles_interrupt() {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext, TurnStatus};
    use std::time::Duration;

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");

    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };

    let rx = provider.start(&context).expect("start should succeed");

    // Wait for SessionInfo to guarantee child process is alive and initialized
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::SessionInfo { .. }));

    provider.send_prompt("interrupt_test").unwrap();

    // Wait for TurnStarted
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::TurnStarted { .. }));

    provider.interrupt().expect("interrupt should succeed");

    let mut interrupted_seen = false;
    let timeout = Duration::from_secs(5);
    while let Ok(evt) = rx.recv_timeout(timeout) {
        if let ProviderEvent::TurnCompleted {
            status: TurnStatus::Interrupted,
            ..
        } = evt
        {
            interrupted_seen = true;
            break;
        }
    }

    assert!(
        interrupted_seen,
        "turn should be completed with Interrupted status"
    );
    provider.shutdown().unwrap();
}

#[test]
fn claude_provider_resume_passes_session_id() {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext};
    use std::time::Duration;

    let wire_log = tempfile::NamedTempFile::new().unwrap();
    let wire_log_path = wire_log.path().to_str().unwrap().to_string();

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");

    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    provider.set_env("OXIDE_WIRE_LOG", &wire_log_path);

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };

    let rx = provider
        .resume("session-xyz-99", &context)
        .expect("resume should succeed");

    // Wait for SessionInfo to guarantee child process has started and logged argv
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::SessionInfo { .. }));

    provider.shutdown().unwrap();

    let wire_contents = std::fs::read_to_string(&wire_log_path).unwrap();
    assert!(
        wire_contents.contains("--resume") && wire_contents.contains("session-xyz-99"),
        "argv should contain --resume session-xyz-99"
    );
}

fn start_and_read_argv(configure: impl FnOnce(&mut ClaudeCodeProvider)) -> String {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext};

    let wire_log = tempfile::NamedTempFile::new().unwrap();
    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    provider.set_env("OXIDE_WIRE_LOG", wire_log.path().to_str().unwrap());
    configure(&mut provider);

    let rx = provider
        .start(&StartContext {
            working_dir: PathBuf::from("."),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Ask,
        })
        .unwrap();
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::SessionInfo { .. }));
    provider.shutdown().unwrap();

    std::fs::read_to_string(wire_log.path()).unwrap()
}

#[test]
fn claude_session_starts_in_safe_mode_by_default() {
    let argv = start_and_read_argv(|_| {});
    assert!(argv.contains("--safe-mode"), "{argv}");
}

#[test]
fn claude_session_keeps_user_customizations_when_enabled() {
    let argv = start_and_read_argv(|p| p.set_user_customizations(ClaudeCustomizations::ALL));
    assert!(!argv.contains("--safe-mode"), "{argv}");
}

#[test]
fn claude_session_switches_off_only_the_categories_left_disabled() {
    let argv = start_and_read_argv(|p| {
        p.set_user_customizations(ClaudeCustomizations {
            skills: true,
            ..ClaudeCustomizations::default()
        })
    });
    assert!(!argv.contains("--safe-mode"), "{argv}");
    assert!(!argv.contains("--disable-slash-commands"), "{argv}");
    for off in ["--strict-mcp-config", "disableAllHooks", "project,local"] {
        assert!(argv.contains(off), "{off} missing from {argv}");
    }
}

#[test]
fn claude_session_skips_safe_mode_when_the_cli_does_not_know_it() {
    let argv = start_and_read_argv(|p| p.set_env("OXIDE_FAKE_NO_SAFE_MODE", "1"));
    assert!(!argv.contains("--safe-mode"), "{argv}");
}

fn pid_alive(pid: i32) -> bool {
    // `kill -0` also succeeds for zombies, so ask ps for the state.
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .map(|o| {
            let stat = String::from_utf8_lossy(&o.stdout);
            !stat.trim().is_empty() && !stat.trim().starts_with('Z')
        })
        .unwrap_or(false)
}

fn wait_for_pid_file(path: &std::path::Path) -> i32 {
    for _ in 0..200 {
        if let Some(pid) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("fake CLI never wrote {path:?}");
}

#[test]
fn shutdown_escalates_and_leaves_no_child_behind() {
    let temp_dir = tempfile::tempdir().unwrap();
    let pid_file = temp_dir.path().join("grandchild.pid");
    let script_path = temp_dir.path().join("stubborn-claude.sh");
    // Ignores SIGTERM (and so does its child), so only SIGKILL on the group ends it.
    fs::write(
        &script_path,
        format!(
            "#!/bin/sh\n[ \"$1\" = --help ] && exit 0\ntrap '' TERM\nsleep 300 &\necho $! > {}\nwait\n",
            pid_file.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).unwrap();

    use oxide_provider::{PermissionMode, StartContext};
    let registry_path = temp_dir.path().join("processes.json");
    let registry = std::sync::Arc::new(oxide_provider::process::ProcessRegistry::open(
        &registry_path,
    ));
    let mut provider = ClaudeCodeProvider::with_command(script_path.to_str().unwrap());
    provider.set_registry(registry);
    let _events = provider
        .start(&StartContext {
            working_dir: temp_dir.path().to_path_buf(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Ask,
        })
        .unwrap();
    let grandchild = wait_for_pid_file(&pid_file);
    assert!(pid_alive(grandchild));
    let recorded = fs::read_to_string(&registry_path).unwrap();
    assert!(recorded.contains("stubborn-claude.sh"), "{recorded}");

    let started = std::time::Instant::now();
    provider.shutdown().unwrap();

    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "SIGKILL only after the 2 s grace"
    );
    assert!(!pid_alive(grandchild), "the process group must be gone");
    assert_eq!(fs::read_to_string(&registry_path).unwrap(), "[]");
}

#[test]
fn claude_model_catalog_comes_from_the_cli() {
    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
    let provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());

    let models = provider.models().unwrap();

    let summary: Vec<_> = models
        .iter()
        .map(|m| (m.id.as_str(), m.name.as_str(), m.is_legacy))
        .collect();
    // `default` repeats `beta`'s model, so it is dropped; the pinned older Beta is legacy.
    assert_eq!(
        summary,
        [
            ("alpha", "Alpha 2", false),
            ("beta", "Beta 2", false),
            ("model-b-1", "Beta 1", true),
            ("model-a-2", "Alpha 2", false),
        ]
    );
    assert_eq!(
        models[0].supported_efforts,
        ["low", "medium", "high", "max"]
    );
    assert_eq!(models[0].description.as_deref(), Some("For complex work"));
    assert!(models[2].supported_efforts.is_empty());
}

#[test]
fn claude_model_catalog_errors_when_the_cli_is_missing() {
    let provider = ClaudeCodeProvider::with_command("nonexistent_binary_xyz_123");
    assert!(provider.models().is_err());
}

#[test]
fn claude_slash_command_catalog_comes_from_the_cli_without_hidden_commands() {
    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    provider.set_user_customizations(oxide_provider::claude::ClaudeCustomizations::ALL);

    let commands = provider.slash_commands(std::path::Path::new(".")).unwrap();

    let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["clear", "compact", "context", "tdd"]);
    let context = commands.iter().find(|c| c.name == "context").unwrap();
    assert_eq!(
        context.description.as_deref(),
        Some("Show current context usage")
    );
    assert_eq!(context.argument_hint, None);
    assert_eq!(context.route, oxide_provider::SlashRoute::Passthrough);
    let compact = commands.iter().find(|c| c.name == "compact").unwrap();
    assert!(compact.argument_hint.is_some());
    let clear = commands.iter().find(|c| c.name == "clear").unwrap();
    assert_eq!(clear.aliases, ["reset", "new"]);
}

#[test]
fn claude_skills_and_custom_commands_only_appear_with_the_skills_customization() {
    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/claude/fake_claude.py");
    let mut provider = ClaudeCodeProvider::with_command(fake_cli.to_str().unwrap());
    let names = |p: &ClaudeCodeProvider| -> Vec<String> {
        p.slash_commands(std::path::Path::new("."))
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect()
    };

    assert!(!names(&provider).contains(&"tdd".to_string()));
    provider.set_user_customizations(oxide_provider::claude::ClaudeCustomizations {
        skills: true,
        ..Default::default()
    });
    assert!(names(&provider).contains(&"tdd".to_string()));
}
