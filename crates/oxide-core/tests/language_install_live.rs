//! Opt-in network smoke test. Installs only under a disposable Oxide home.
use oxide_core::Core;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[test]
#[ignore = "Downloads official Python, TypeScript and Rust language support into a temporary home"]
fn managed_python_typescript_and_rust_install_and_initialize() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let core = Core::open(temporary.path().join("home")).unwrap();
    let id = core.add_project(&project.to_string_lossy()).unwrap().id;
    for language in ["python", "typescript", "rust"] {
        println!("Installing {language}");
        assert!(
            core.install_language_support(language, |_| {})
                .unwrap()
                .installed
        );
        let (server, rx) = core.start_language_server(id, None, language).unwrap();
        let root = reqwest::Url::from_directory_path(&project)
            .unwrap()
            .to_string();
        let options: Value = serde_json::from_str(&server.initialization_options).unwrap();
        core.language_server_message(server.id, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":root,"capabilities":{},"initializationOptions":options}}).to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "{language} did not initialize");
            let message: Value =
                serde_json::from_str(&rx.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
            assert_ne!(
                message["method"], "$/oxide/serverExited",
                "{language} exited"
            );
            if message["id"] == 1 {
                assert!(message.get("result").is_some(), "{language}: {message}");
                break;
            }
        }
        core.stop_language_server(server.id);
    }
}

#[test]
#[ignore = "Downloads the official clangd release into a temporary home"]
fn managed_clangd_download_connect_and_unsaved_diagnostics() {
    let temporary = tempfile::tempdir().unwrap();
    let project = temporary.path().join("project");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    let file = project.join("main.c");
    std::fs::write(&file, "int main() { return 0; }\n").unwrap();
    let core = Core::open(temporary.path().join("home")).unwrap();
    let id = core.add_project(&project.to_string_lossy()).unwrap().id;
    let tool = core
        .install_language_support("cpp", |message| {
            if !message.contains('%') {
                println!("{message}");
            }
        })
        .unwrap();
    assert!(tool.installed);
    assert!(
        tool.resolved_path
            .as_ref()
            .unwrap()
            .starts_with(&temporary.path().join("home").to_string_lossy().into_owned())
    );
    let (server, rx) = core.start_language_server(id, None, "cpp").unwrap();
    let uri = reqwest::Url::from_file_path(&file).unwrap().to_string();
    let root = reqwest::Url::from_directory_path(&project)
        .unwrap()
        .to_string();
    let send = |value: Value| {
        core.language_server_message(server.id, &value.to_string())
            .unwrap()
    };
    send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":root,"capabilities":{}}}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline);
        let message: Value =
            serde_json::from_str(&rx.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
        if message["id"] == 1 {
            assert!(message.get("result").is_some(), "{message}");
            break;
        }
    }
    send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    send(
        json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":uri,"languageId":"c","version":1,"text":"int main() { missing_symbol; }\n"}}}),
    );
    loop {
        assert!(Instant::now() < deadline);
        let message: Value =
            serde_json::from_str(&rx.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
        if message["method"] == "textDocument/publishDiagnostics"
            && message["params"]["diagnostics"]
                .as_array()
                .is_some_and(|d| !d.is_empty())
        {
            break;
        }
    }
    send(
        json!({"jsonrpc":"2.0","method":"textDocument/didChange","params":{"textDocument":{"uri":uri,"version":2},"contentChanges":[{"text":"int main() { return 0; }\n"}]}}),
    );
    loop {
        assert!(Instant::now() < deadline);
        let message: Value =
            serde_json::from_str(&rx.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
        if message["method"] == "textDocument/publishDiagnostics"
            && message["params"]["version"] == 2
        {
            assert!(
                message["params"]["diagnostics"]
                    .as_array()
                    .unwrap()
                    .is_empty(),
                "{message}"
            );
            break;
        }
    }
    core.stop_language_server(server.id);
}
