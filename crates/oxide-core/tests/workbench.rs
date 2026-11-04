use oxide_core::{Core, LanguageServerConfig};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn fixture() -> (tempfile::TempDir, Core, u32) {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    std::fs::create_dir_all(project.join("subdir")).unwrap();
    let core = Core::open(temporary.path().join("home")).unwrap();
    let id = core.add_project(&project.to_string_lossy()).unwrap().id;
    (temporary, core, id)
}

#[test]
fn saves_complete_files_but_never_overwrites_a_stale_buffer() {
    let (temporary, core, id) = fixture();
    let path = temporary.path().join("project/main.py");
    std::fs::write(&path, "print('before')\r\n").unwrap();
    let original = core.read_file(id, None, "main.py").unwrap().content;
    core.write_file(id, None, "main.py", &original, "print('after')\r\n")
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "print('after')\r\n"
    );
    std::fs::write(&path, "agent's changes").unwrap();
    assert!(
        core.write_file(id, None, "main.py", "print('after')\r\n", "my changes")
            .unwrap_err()
            .to_string()
            .contains("changed on disk")
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "agent's changes");
    assert!(core.write_file(id, None, "../outside", "", "no").is_err());
}

#[test]
fn new_files_do_not_overwrite_existing_files_or_escape_the_project() {
    let (temporary, core, id) = fixture();
    core.create_file(id, None, "subdir/new.rs").unwrap();
    assert!(temporary.path().join("project/subdir/new.rs").is_file());
    assert!(core.create_file(id, None, "subdir/new.rs").is_err());
    assert!(core.create_file(id, None, "../escape.py").is_err());
    std::fs::write(temporary.path().join("project/.gitignore"), "ignored/\n").unwrap();
    std::fs::create_dir_all(temporary.path().join("project/ignored")).unwrap();
    std::fs::write(temporary.path().join("project/ignored/secret.rs"), "no").unwrap();
    assert_eq!(core.find_files(id, None, ".rs").unwrap(), ["subdir/new.rs"]);
    core.set_editor_dirty("project-main".into(), true);
    assert_eq!(core.dirty_editor_count(), 1);
    core.set_editor_dirty("project-main".into(), false);
    assert_eq!(core.dirty_editor_count(), 0);
}

fn until(core: &Core, id: u32, rx: &crossbeam_channel::Receiver<Vec<u8>>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut bytes = Vec::new();
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            if chunk.windows(4).any(|window| window == b"\x1b[6n") {
                core.write_terminal(id, b"\x1b[1;1R").unwrap();
            }
            bytes.extend(chunk);
        }
        let output = String::from_utf8_lossy(&bytes);
        if output.contains(needle) {
            return output.into_owned();
        }
    }
    panic!(
        "Did not receive {needle:?}: {}",
        String::from_utf8_lossy(&bytes)
    );
}

/// A terminal view that keeps reading for the whole test, as the app's own view does:
/// `until` stops reading as soon as it has what it waited for, and a view left behind
/// must not hold up the shell (see `a_stalled_terminal_view_never_stalls_the_shell`).
struct Drained {
    bytes: Arc<Mutex<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    reader: Option<std::thread::JoinHandle<()>>,
}

fn drain_terminal(core: &Arc<Core>, terminal_id: u32) -> Drained {
    let rx = core.subscribe_terminal(terminal_id).unwrap();
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let core = Arc::clone(core);
        let bytes = Arc::clone(&bytes);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) else {
                    continue;
                };
                for _ in 0..chunk.windows(4).filter(|w| *w == b"\x1b[6n").count() {
                    let _ = core.write_terminal(terminal_id, b"\x1b[1;1R");
                }
                bytes.lock().unwrap().extend(chunk);
            }
        })
    };
    Drained {
        bytes,
        stop,
        reader: Some(reader),
    }
}

impl Drained {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }

    fn wait_for(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let output = self.text();
            if output.contains(needle) {
                return output;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let output = self.text();
        panic!(
            "Did not receive {needle:?} in {} bytes: {}",
            output.len(),
            &output[output.len().saturating_sub(2000)..]
        );
    }
}

impl Drop for Drained {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// A view that stops reading must not stop the shell for the views that do read.
#[test]
fn a_stalled_terminal_view_never_stalls_the_shell() {
    let (_temporary, core, id) = fixture();
    let core = Arc::new(core);
    let terminal = core.start_block_terminal(id, None).unwrap();
    // Never read: the view's buffer fills and stays full.
    let _stalled = core.subscribe_terminal(terminal.id).unwrap();
    let live = drain_terminal(&core, terminal.id);
    // More than the stalled view's buffer holds, so the terminal has to drop it
    // rather than wait for it before the reading view gets anything.
    #[cfg(windows)]
    let command = "Write-Output ('x' * 3000000)";
    #[cfg(not(windows))]
    let command = "head -c 3000000 /dev/zero | tr '\\0' x";
    core.run_terminal_block(terminal.id, command, "flood")
        .unwrap();
    live.wait_for("flood;end;0;");
    assert!(
        live.text().contains("xxxxxx"),
        "the reading view never saw the flood"
    );
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn terminal_blocks_keep_shell_variables_directory_and_exit_status() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id, None).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    #[cfg(windows)]
    let first = "$savedValue=42; Set-Location subdir; Write-Output 'first output'";
    #[cfg(not(windows))]
    let first = "savedValue=42; cd subdir; printf 'first output\\n'";
    core.run_terminal_block(terminal.id, first, "first")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "first;end;0;");
    assert!(output.contains("first output"), "{output}");
    assert!(output.contains("subdir"), "{output}");
    #[cfg(windows)]
    let second = "Write-Output \"kept:$savedValue\"; cmd /c exit 7";
    #[cfg(not(windows))]
    let second = "printf 'kept:%s\\n' \"$savedValue\"; sh -c 'exit 7'";
    core.run_terminal_block(terminal.id, second, "second")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "second;end;7;");
    assert!(output.contains("kept:42"), "{output}");
    assert!(
        core.run_terminal_block(terminal.id, "echo bad", "bad;token")
            .is_err()
    );
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn terminal_block_accepts_interactive_input() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id, None).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    #[cfg(windows)]
    let command = "$name=Read-Host 'Enter name'; Write-Output \"Hello $name\"";
    #[cfg(not(windows))]
    let command = "printf 'Enter name'; read name; printf 'Hello %s\\n' \"$name\"";
    core.run_terminal_block(terminal.id, command, "interactive")
        .unwrap();
    until(&core, terminal.id, &rx, "Enter name");
    core.write_terminal(
        terminal.id,
        if cfg!(windows) { b"Ada\r\n" } else { b"Ada\n" },
    )
    .unwrap();
    let output = until(&core, terminal.id, &rx, "interactive;end;0;");
    assert!(output.contains("Hello Ada"), "{output}");
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn language_server_transports_unsaved_diagnostics_and_completion() {
    let (_temporary, core, id) = fixture();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/lsp.py");
    core.configure_language_server(
        "python",
        LanguageServerConfig {
            command: "python".into(),
            args: vec![script.to_string_lossy().into_owned()],
            interpreter: None,
        },
    )
    .unwrap();
    let (server, rx) = core.start_language_server(id, None, "python").unwrap();
    core.language_server_message(
        server.id,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    )
    .unwrap();
    fn next(rx: &crossbeam_channel::Receiver<String>) -> serde_json::Value {
        loop {
            let message: serde_json::Value =
                serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
            if message["method"] != "window/logMessage" {
                return message;
            }
        }
    }
    let initialized = next(&rx);
    assert_eq!(initialized["id"], 1, "{initialized}");
    core.language_server_message(server.id, r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///main.py","text":"broken"}}}"#).unwrap();
    let diagnostics = next(&rx);
    assert_eq!(
        diagnostics["params"]["diagnostics"][0]["message"],
        "Syntax error: broken"
    );
    core.language_server_message(
        server.id,
        r#"{"jsonrpc":"2.0","id":2,"method":"textDocument/completion","params":{}}"#,
    )
    .unwrap();
    let completion = next(&rx);
    assert_eq!(completion["result"][0]["label"], "print");
    core.stop_language_server(server.id);
    assert!(core.language_server_message(server.id, "{}").is_err());
}

#[test]
fn shell_completion_uses_the_live_directory_and_never_runs_the_typed_command() {
    let (temporary, core, id) = fixture();
    std::fs::write(
        temporary
            .path()
            .join("project/subdir/completion-example.txt"),
        "fixture",
    )
    .unwrap();
    let terminal = core.start_block_terminal(id, None).unwrap();
    assert!(!terminal.cwd.starts_with("\\\\?\\"));
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(terminal.id, "cd subdir", "change")
        .unwrap();
    until(&core, terminal.id, &rx, "change;end;0;");
    let line = "cat comp";
    let result = core
        .complete_terminal(
            terminal.id,
            line,
            line.len(),
            &temporary.path().join("project/subdir").to_string_lossy(),
        )
        .unwrap();
    assert_eq!(result.replacement_index, 4);
    assert!(
        result
            .matches
            .iter()
            .any(|item| item.text.contains("completion-example.txt")),
        "{result:?}"
    );
    let absent = core
        .complete_terminal(terminal.id, "cat no-such-file-oxide-123", 25, &terminal.cwd)
        .unwrap();
    assert!(absent.matches.is_empty());
    core.close_terminal(terminal.id).unwrap();
}

#[test]
fn interrupting_a_program_keeps_the_shell_usable() {
    let (_temporary, core, id) = fixture();
    let terminal = core.start_block_terminal(id, None).unwrap();
    let rx = core.subscribe_terminal(terminal.id).unwrap();
    core.run_terminal_block(
        terminal.id,
        "python -c \"import time; print('WAITING_FOR_INTERRUPT',flush=True); time.sleep(30)\"",
        "wait",
    )
    .unwrap();
    until(&core, terminal.id, &rx, "WAITING_FOR_INTERRUPT");
    core.write_terminal(terminal.id, b"\x03").unwrap();
    until(&core, terminal.id, &rx, "wait;end;");
    core.run_terminal_block(terminal.id, "echo STILL_USABLE", "after")
        .unwrap();
    let output = until(&core, terminal.id, &rx, "after;end;0;");
    assert!(output.contains("STILL_USABLE"));
    core.close_terminal(terminal.id).unwrap();
}
