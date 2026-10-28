//! Test-only JSON-lines transport used by web/scripts/terminal-regression.cjs.
use oxide_core::Core;
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::Arc;
fn emit(value: Value) {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "{value}").unwrap();
    stdout.flush().unwrap();
}
fn main() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("terminal project");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::write(root.join("completion-example.txt"), "fixture").unwrap();
    std::fs::write(
        root.join("tui_fixture.py"),
        include_str!("../fixtures/terminal_tui.py"),
    )
    .unwrap();
    let core = Arc::new(Core::open(temporary.path().join("home")).unwrap());
    let project = core.add_project(&root.to_string_lossy()).unwrap();
    emit(json!({"ready":true,"root":project.path}));
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let request: Value = serde_json::from_str(&line).unwrap();
        let core = Arc::clone(&core);
        let project_id = project.id;
        std::thread::spawn(move || {
            let args = &request["args"];
            let id = args["terminalId"].as_u64().unwrap_or(0) as u32;
            let result = match request["cmd"].as_str().unwrap() {
                "start_block_terminal" => {
                    core.start_block_terminal(project_id, None).map(|terminal| {
                        let receiver = core.subscribe_terminal(terminal.id).unwrap();
                        std::thread::spawn(move || {
                            for bytes in receiver {
                                emit(json!({"bytes":bytes}));
                            }
                        });
                        serde_json::to_value(terminal).unwrap()
                    })
                }
                "write_terminal" => core
                    .write_terminal(
                        id,
                        &serde_json::from_value::<Vec<u8>>(args["input"].clone()).unwrap(),
                    )
                    .map(|_| Value::Null),
                "resize_terminal" => core
                    .resize_terminal(
                        id,
                        args["rows"].as_u64().unwrap() as u16,
                        args["cols"].as_u64().unwrap() as u16,
                    )
                    .map(|_| Value::Null),
                "run_terminal_block" => core
                    .run_terminal_block(
                        id,
                        args["command"].as_str().unwrap(),
                        args["token"].as_str().unwrap(),
                    )
                    .map(|_| Value::Null),
                "complete_terminal" => core
                    .complete_terminal(
                        id,
                        args["line"].as_str().unwrap(),
                        args["cursor"].as_u64().unwrap() as usize,
                        args["cwd"].as_str().unwrap(),
                    )
                    .map(|value| serde_json::to_value(value).unwrap()),
                "close_terminal" => core.close_terminal(id).map(|_| Value::Null),
                _ => panic!("Unknown harness command"),
            };
            emit(
                json!({"request":request["request"],"result":result.map_err(|error|error.to_string())}),
            );
        });
    }
    core.shutdown();
}
