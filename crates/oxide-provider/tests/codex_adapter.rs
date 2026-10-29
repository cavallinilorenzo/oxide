#[cfg(unix)]
use oxide_provider::Provider;
#[cfg(unix)]
use oxide_provider::codex::CodexProvider;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
fn make_fake_cli(dir: &std::path::Path, version: &str, logged_in: bool) -> PathBuf {
    let script_path = dir.join("fake-codex.sh");
    let auth_exit = if logged_in { 0 } else { 1 };
    let auth_msg = if logged_in {
        "Logged in using ChatGPT"
    } else {
        "Not logged in"
    };
    let content = format!(
        r#"#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then
    echo "codex-cli {version}"
    exit 0
elif [ "$1" = "login" ] && [ "$2" = "status" ]; then
    echo "{auth_msg}"
    exit {auth_exit}
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

#[cfg(unix)]
#[test]
fn codex_detect_missing_cli() {
    let provider = CodexProvider::with_command("nonexistent_codex_binary_xyz_123");
    let detection = provider
        .detect()
        .expect("detect should not error on missing binary");
    assert!(!detection.installed);
    assert!(!detection.authenticated);
    assert!(!detection.available);
    assert_eq!(detection.version, None);
    assert!(detection.warning.is_some());
    let warning = detection.warning.unwrap();
    assert!(
        warning.to_lowercase().contains("install") || warning.to_lowercase().contains("missing"),
        "warning should include install hint"
    );
}

#[cfg(unix)]
#[test]
fn codex_detect_installed_and_authenticated_pinned_version() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "0.163.0", true);

    let provider = CodexProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(detection.authenticated);
    assert!(detection.available);
    assert_eq!(detection.version.as_deref(), Some("0.163.0"));
    assert_eq!(detection.warning, None);
}

#[cfg(unix)]
#[test]
fn codex_detect_installed_outside_pinned_range_gives_warning_not_block() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "2.5.0", true);

    let provider = CodexProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(detection.authenticated);
    assert!(
        detection.available,
        "out-of-range version should warn, not block"
    );
    assert_eq!(detection.version.as_deref(), Some("2.5.0"));
    assert!(
        detection.warning.is_some(),
        "detection warning should be present when version is outside pinned range"
    );
    let warning = detection.warning.unwrap();
    assert!(warning.contains("2.5.0"));
}

#[cfg(unix)]
#[test]
fn codex_detect_installed_but_logged_out() {
    let temp_dir = tempfile::tempdir().unwrap();
    let cli_path = make_fake_cli(temp_dir.path(), "0.163.0", false);

    let provider = CodexProvider::with_command(cli_path.to_str().unwrap());
    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.installed);
    assert!(!detection.authenticated);
    assert!(!detection.available);
    assert_eq!(detection.version.as_deref(), Some("0.163.0"));
    assert!(detection.warning.is_some());
    let warning = detection.warning.unwrap();
    assert!(
        warning.to_lowercase().contains("login") || warning.to_lowercase().contains("authenticate"),
        "warning should include login hint"
    );
}

#[cfg(unix)]
#[test]
fn two_threads_share_one_app_server_process_each_with_its_own_cwd() {
    use oxide_provider::codex::CodexAppServer;
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext, TurnStatus};
    use std::sync::Arc;
    use std::time::Duration;

    let wire_log = tempfile::NamedTempFile::new().unwrap();
    let wire_log_path = wire_log.path().to_str().unwrap().to_string();

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");

    let mut app_server = CodexAppServer::with_command(fake_cli.to_str().unwrap());
    app_server.set_env("OXIDE_WIRE_LOG", &wire_log_path);
    let app_server = Arc::new(app_server);

    let mut p1 = app_server.create_provider();
    let mut p2 = app_server.create_provider();

    let cwd1 = PathBuf::from("/cwd/project-one");
    let cwd2 = PathBuf::from("/cwd/project-two");

    let rx1 = p1
        .start(&StartContext {
            working_dir: cwd1.clone(),
            model: Some("gpt-5".into()),
            effort: None,
            permission_mode: PermissionMode::AutoEdit,
        })
        .expect("p1 start should succeed");

    let rx2 = p2
        .start(&StartContext {
            working_dir: cwd2.clone(),
            model: Some("gpt-5".into()),
            effort: None,
            permission_mode: PermissionMode::Ask,
        })
        .expect("p2 start should succeed");

    // Both threads receive SessionInfo with their respective thread IDs
    let s1 = rx1.recv_timeout(Duration::from_secs(5)).unwrap();
    let s2 = rx2.recv_timeout(Duration::from_secs(5)).unwrap();

    let tid1 = match s1 {
        ProviderEvent::SessionInfo { session_id } => session_id,
        _ => panic!("Expected SessionInfo for p1"),
    };
    let tid2 = match s2 {
        ProviderEvent::SessionInfo { session_id } => session_id,
        _ => panic!("Expected SessionInfo for p2"),
    };

    assert_ne!(tid1, tid2, "thread IDs should be distinct");

    // Send prompt to p1
    p1.send_prompt("Hello test")
        .expect("p1 send_prompt should succeed");

    // Verify p1 receives TurnStarted and completion
    let mut p1_turn_completed = false;
    while let Ok(evt) = rx1.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { status, .. } = evt {
            assert_eq!(status, TurnStatus::Completed);
            p1_turn_completed = true;
            break;
        }
    }
    assert!(p1_turn_completed, "p1 turn should complete");

    // Verify p2 received no prompt events (only SessionInfo)
    assert!(
        rx2.try_recv().is_err(),
        "p2 should not receive events meant for p1"
    );

    // Read wire log
    let wire_contents = std::fs::read_to_string(&wire_log_path).unwrap();
    let mut argv_count = 0;
    for line in wire_contents.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line)
            && val.get("type").and_then(|v| v.as_str()) == Some("argv")
        {
            argv_count += 1;
        }
    }

    assert_eq!(
        argv_count, 1,
        "Exactly one app-server process should have been spawned for both threads"
    );
    assert!(
        wire_contents.contains("/cwd/project-one"),
        "wire log should show cwd1 used"
    );
    assert!(
        wire_contents.contains("/cwd/project-two"),
        "wire log should show cwd2 used"
    );

    // Shut down p1 while p2 is still alive
    p1.shutdown().expect("p1 shutdown should succeed");

    // Send prompt to p2 and verify it completes (shared app-server still alive!)
    p2.send_prompt("Hello test on p2")
        .expect("p2 send_prompt should succeed");
    let mut p2_turn_completed = false;
    while let Ok(evt) = rx2.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { turn_index, status } = evt {
            assert_eq!(status, TurnStatus::Completed);
            assert_eq!(turn_index, 0);
            p2_turn_completed = true;
            break;
        }
    }
    assert!(
        p2_turn_completed,
        "p2 turn should complete after p1 shutdown"
    );

    // Second turn on p2: verifies turn_index is 1
    p2.send_prompt("Second prompt on p2")
        .expect("p2 second prompt should succeed");
    let mut p2_second_turn_completed = false;
    while let Ok(evt) = rx2.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { turn_index, status } = evt {
            assert_eq!(status, TurnStatus::Completed);
            assert_eq!(turn_index, 1);
            p2_second_turn_completed = true;
            break;
        }
    }
    assert!(
        p2_second_turn_completed,
        "p2 second turn should report turn_index 1"
    );

    p2.shutdown().expect("p2 shutdown should succeed");
}

#[cfg(unix)]
#[test]
fn server_initiated_approval_answered_while_client_request_in_flight_no_deadlock() {
    use oxide_provider::{
        ApprovalDecision, ApprovalKind, PermissionMode, ProviderEvent, StartContext, TurnStatus,
    };
    use std::time::Duration;

    let wire_log = tempfile::NamedTempFile::new().unwrap();
    let wire_log_path = wire_log.path().to_str().unwrap().to_string();

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");

    let mut provider = CodexProvider::with_command(fake_cli.to_str().unwrap());
    provider.set_env("OXIDE_WIRE_LOG", &wire_log_path);

    let rx = provider
        .start(&StartContext {
            working_dir: PathBuf::from("."),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Ask,
        })
        .expect("start should succeed");

    // Consume SessionInfo
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::SessionInfo { .. }));

    // Send deadlock_test in a background thread so turn/start is in flight while approval is answered
    let mut provider_clone = provider.clone();
    let (tx_start_done, rx_start_done) = crossbeam_channel::bounded(1);

    // Prompt sends "deadlock_test". The fake server delays replying to turn/start and emits approval request
    std::thread::spawn(move || {
        let res = provider_clone.send_prompt("deadlock_test");
        let _ = tx_start_done.send(res);
    });

    // We should receive ApprovalRequested on rx while turn/start is in flight
    let mut approval_seen = false;
    while let Ok(evt) = rx.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::ApprovalRequested {
            id, kind, summary, ..
        } = evt
        {
            assert_eq!(id, "appr-deadlock");
            assert_eq!(kind, ApprovalKind::Command);
            assert_eq!(summary, "cargo test deadlock");
            approval_seen = true;

            // Answer the approval while turn/start is STILL in flight
            provider
                .respond_to_approval(&id, ApprovalDecision::Allow)
                .expect("respond_to_approval should succeed while request in flight");
            break;
        }
    }

    assert!(approval_seen, "ApprovalRequested should be received");

    // turn/start in the background thread should complete now
    let start_res = rx_start_done
        .recv_timeout(Duration::from_secs(5))
        .expect("send_prompt should complete after approval is answered");
    assert!(start_res.is_ok(), "send_prompt should succeed");

    // Receiver should see TurnCompleted
    let mut turn_completed = false;
    while let Ok(evt) = rx.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { status, .. } = evt {
            assert_eq!(status, TurnStatus::Completed);
            turn_completed = true;
            break;
        }
    }
    assert!(
        turn_completed,
        "turn should complete successfully without deadlock"
    );

    // Verify wire log confirms approval answered while in flight
    let wire_contents = std::fs::read_to_string(&wire_log_path).unwrap();
    assert!(
        wire_contents.contains("deadlock_approval_answered_in_flight"),
        "approval was answered in flight"
    );

    provider.shutdown().expect("shutdown should succeed");
}

#[cfg(unix)]
#[test]
fn version_mismatch_at_handshake_produces_warning_not_block() {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext, TurnStatus};
    use std::time::Duration;

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");

    let mut provider = CodexProvider::with_command(fake_cli.to_str().unwrap());
    // Force fake version to 2.5.0 (outside pinned range >= 0.100.0, < 1.0.0)
    provider.set_env("OXIDE_FAKE_VERSION", "2.5.0");

    let detection = provider.detect().expect("detect must succeed");
    assert!(detection.available, "detection must not be blocked");
    assert!(detection.warning.is_some(), "detection must have warning");

    let context = StartContext {
        working_dir: PathBuf::from("."),
        model: None,
        effort: None,
        permission_mode: PermissionMode::AutoEdit,
    };

    // start() runs initialize handshake. Must succeed without blocking!
    let rx = provider
        .start(&context)
        .expect("start must succeed despite version mismatch");
    assert!(
        provider.app_server().warning().is_some(),
        "handshake warning must be recorded on app-server"
    );
    let warning = provider.app_server().warning().unwrap();
    assert!(warning.contains("2.5.0"));

    provider
        .send_prompt("Hello test")
        .expect("prompt must succeed");

    let mut turn_completed = false;
    while let Ok(evt) = rx.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { status, .. } = evt {
            assert_eq!(status, TurnStatus::Completed);
            turn_completed = true;
            break;
        }
    }
    assert!(turn_completed, "turn must complete despite version warning");

    provider.shutdown().expect("shutdown must succeed");
}

#[cfg(unix)]
#[test]
fn codex_provider_handles_interrupt() {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext, TurnStatus};
    use std::time::Duration;

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");

    let mut provider = CodexProvider::with_command(fake_cli.to_str().unwrap());
    let rx = provider
        .start(&StartContext {
            working_dir: PathBuf::from("."),
            model: None,
            effort: None,
            permission_mode: PermissionMode::AutoEdit,
        })
        .expect("start should succeed");

    // Wait for SessionInfo
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::SessionInfo { .. }));

    // Send interrupt_test prompt in background
    let mut provider_clone = provider.clone();
    std::thread::spawn(move || {
        let _ = provider_clone.send_prompt("interrupt_test");
    });

    // Wait for TurnStarted
    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(evt, ProviderEvent::TurnStarted { .. }));

    // Interrupt
    provider.interrupt().expect("interrupt should succeed");

    let mut interrupted_seen = false;
    while let Ok(evt) = rx.recv_timeout(Duration::from_secs(5)) {
        if let ProviderEvent::TurnCompleted { status, .. } = evt {
            assert_eq!(status, TurnStatus::Interrupted);
            interrupted_seen = true;
            break;
        }
    }

    assert!(
        interrupted_seen,
        "turn should complete with Interrupted status"
    );
    provider.shutdown().expect("shutdown should succeed");
}

#[cfg(unix)]
#[test]
fn codex_provider_resume_passes_session_id() {
    use oxide_provider::{PermissionMode, ProviderEvent, StartContext};
    use std::time::Duration;

    let fake_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");

    let mut provider = CodexProvider::with_command(fake_cli.to_str().unwrap());
    let rx = provider
        .resume(
            "session-codex-xyz-99",
            &StartContext {
                working_dir: PathBuf::from("."),
                model: None,
                effort: None,
                permission_mode: PermissionMode::AutoEdit,
            },
        )
        .expect("resume should succeed");

    let evt = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    match evt {
        ProviderEvent::SessionInfo { session_id } => {
            assert_eq!(session_id, "session-codex-xyz-99");
        }
        other => panic!("Expected SessionInfo, got {:?}", other),
    }

    provider.shutdown().expect("shutdown should succeed");
}

mod native_commands {
    use oxide_provider::{
        ItemKind, PermissionMode, Provider, ProviderEvent, SlashRoute, StartContext, TurnStatus,
        codex::CodexProvider,
    };
    use std::path::PathBuf;

    #[cfg(windows)]
    fn python_executable() -> PathBuf {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("python.exe"))
            .find(|candidate| candidate.is_file())
            .expect("Python is installed on the Windows test runner")
    }

    fn fake_cli(dir: &std::path::Path) -> PathBuf {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/codex/fake_codex.py");
        #[cfg(windows)]
        {
            let python = python_executable();
            let wrapper = dir.join("fake-codex.cmd");
            std::fs::write(
                &wrapper,
                format!(
                    "@echo off\r\n\"{}\" \"{}\" %*\r\n",
                    python.display(),
                    script.display()
                ),
            )
            .unwrap();
            wrapper
        }
        #[cfg(unix)]
        {
            let _ = dir;
            script
        }
    }

    fn fake_provider(dir: &std::path::Path) -> CodexProvider {
        let command = fake_cli(dir);
        let mut provider = CodexProvider::with_command(command.to_str().unwrap());
        #[cfg(windows)]
        {
            let python_dir = python_executable().parent().unwrap().to_path_buf();
            let system_dir =
                PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
            let path = std::env::join_paths([python_dir, system_dir]).unwrap();
            provider.set_env("PATH", path.to_string_lossy());
        }
        provider
    }

    #[test]
    fn codex_catalog_offers_native_commands_and_skills() {
        let dir = tempfile::tempdir().unwrap();
        let provider = fake_provider(dir.path());
        let commands = provider.slash_commands(dir.path()).unwrap();
        let names: Vec<_> = commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["compact", "review", "sample-skill"]);
        assert!(commands.iter().all(|c| c.route == SlashRoute::Native));
    }

    #[test]
    fn catalog_refetches_skills_after_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_FAKE_SKILLS_CHANGE", "1");
        assert!(
            provider
                .slash_commands(dir.path())
                .unwrap()
                .iter()
                .any(|c| c.name == "sample-skill")
        );
        let refreshed = provider.slash_commands(dir.path()).unwrap();
        assert!(refreshed.iter().any(|c| c.name == "new-skill"));
        assert!(!refreshed.iter().any(|c| c.name == "sample-skill"));
    }

    #[test]
    fn compact_is_a_turn_with_command_output() {
        let dir = tempfile::tempdir().unwrap();
        let mut provider = fake_provider(dir.path());
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        provider.send_prompt("/compact").unwrap();
        let mut started = false;
        let mut output = 0;
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap() {
                ProviderEvent::TurnStarted { prompt, .. } => {
                    assert_eq!(prompt, "/compact");
                    started = true;
                }
                ProviderEvent::ItemCompleted {
                    kind: ItemKind::SlashCommandOutput,
                    content,
                    ..
                } => {
                    assert!(!content.is_empty());
                    output += 1;
                }
                ProviderEvent::TurnCompleted { status, .. } => {
                    assert_eq!(status, TurnStatus::Completed);
                    break;
                }
                _ => {}
            }
        }
        assert!(started);
        assert_eq!(output, 1);
        provider.shutdown().unwrap();
    }

    #[test]
    fn review_runs_inline_and_preserves_unknown_items() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("wire.log");
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        provider.send_prompt("/review check security").unwrap();
        let mut review = false;
        let mut unknown = false;
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap() {
                ProviderEvent::ItemCompleted {
                    kind: ItemKind::SlashCommandOutput,
                    content,
                    ..
                } if content.contains("Review findings") => review = true,
                ProviderEvent::Unknown { raw } if raw.contains("futureReviewItem") => {
                    unknown = true
                }
                ProviderEvent::TurnCompleted { status, .. } => {
                    assert_eq!(status, TurnStatus::Completed);
                    break;
                }
                _ => {}
            }
        }
        assert!(review && unknown);
        let wire = std::fs::read_to_string(log).unwrap();
        assert!(wire.contains("review/start") && wire.contains("check security"));
        provider.shutdown().unwrap();
    }

    #[test]
    fn skill_is_sent_as_structured_input_followed_by_text() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("wire.log");
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        provider.send_prompt("/sample-skill do the thing").unwrap();
        while !matches!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            ProviderEvent::TurnCompleted { .. }
        ) {}
        let wire = std::fs::read_to_string(log).unwrap();
        let requests: Vec<serde_json::Value> = wire
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let request = requests
            .iter()
            .find(|v| v["data"]["method"] == "turn/start")
            .unwrap();
        assert_eq!(
            request["data"]["params"]["input"],
            serde_json::json!([
                {"type":"skill", "name":"sample-skill", "path":"/skills/sample/SKILL.md"},
                {"type":"text", "text":"do the thing"}
            ])
        );
        provider.shutdown().unwrap();
    }

    #[test]
    fn rejected_native_command_ends_the_turn_with_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_FAKE_REJECT_REVIEW", "1");
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        assert!(provider.send_prompt("/review").is_err());
        loop {
            if let ProviderEvent::TurnCompleted { status, .. } =
                rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap()
            {
                assert_eq!(status, TurnStatus::Error);
                break;
            }
        }
        provider.shutdown().unwrap();
    }

    #[test]
    fn skills_changed_reaches_the_thread() {
        let dir = tempfile::tempdir().unwrap();
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_FAKE_SKILLS_CHANGE", "1");
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        provider.slash_commands(dir.path()).unwrap();
        while !matches!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            ProviderEvent::SlashCommandsChanged
        ) {}
        provider.shutdown().unwrap();
    }

    #[test]
    fn listed_skill_stays_structured_if_refresh_fails() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("wire.log");
        let mut provider = fake_provider(dir.path());
        provider.set_env("OXIDE_WIRE_LOG", log.to_str().unwrap());
        provider.set_env("OXIDE_FAKE_SKILLS_FAIL_AFTER_FIRST", "1");
        let rx = provider
            .start(&StartContext {
                working_dir: dir.path().into(),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Ask,
            })
            .unwrap();
        provider.slash_commands(dir.path()).unwrap();
        provider.send_prompt("/sample-skill hello").unwrap();
        while !matches!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            ProviderEvent::TurnCompleted { .. }
        ) {}
        let wire = std::fs::read_to_string(log).unwrap();
        let requests: Vec<serde_json::Value> = wire
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let request = requests
            .iter()
            .find(|v| v["data"]["method"] == "turn/start")
            .unwrap();
        assert_eq!(request["data"]["params"]["input"][0]["type"], "skill");
        provider.shutdown().unwrap();
    }
}
