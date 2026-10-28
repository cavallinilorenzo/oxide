//! Local language servers. Core owns process lifetime and stdio framing; the editor owns LSP.
use crate::{Error, Result};
use crossbeam_channel::{Receiver, bounded};
use oxide_provider::command::find_in;
use oxide_provider::process::{
    ProcessRegistry, SHUTDOWN_GRACE, attach_child_to_job, release_job, spawn_in_own_group,
    terminate_group,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const LANGUAGES: [(&str, &str, &str, &[&str]); 4] = [
    (
        "python",
        "Python · Pyright",
        "pyright-langserver",
        &["--stdio"],
    ),
    ("cpp", "C / C++ · clangd", "clangd", &[]),
    (
        "typescript",
        "JavaScript / TypeScript",
        "typescript-language-server",
        &["--stdio"],
    ),
    ("rust", "Rust · rust-analyzer", "rust-analyzer", &[]),
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerConfig {
    pub command: String,
    pub args: Vec<String>,
    pub interpreter: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageTool {
    pub language: String,
    pub name: String,
    pub config: LanguageServerConfig,
    pub installed: bool,
    pub resolved_path: Option<String>,
    pub install_command: String,
    pub documentation: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageServerSummary {
    pub id: u32,
    pub root: String,
    pub language: String,
    pub initialization_options: String,
}

fn failure(message: impl ToString) -> Error {
    Error::Editor(message.to_string())
}

fn definition(language: &str) -> Result<(&'static str, &'static str, &'static [&'static str])> {
    LANGUAGES
        .iter()
        .find(|d| d.0 == language)
        .map(|d| (d.1, d.2, d.3))
        .ok_or_else(|| failure("Unsupported language server."))
}

fn configurations(home: &Path) -> HashMap<String, LanguageServerConfig> {
    std::fs::read(home.join("language-servers.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn resolve(program: &str, home: &Path) -> Option<PathBuf> {
    let mut directories = vec![
        home.join("tools/language-servers/node_modules/.bin"),
        home.join("tools/language-servers/bin"),
    ];
    if let Some(user) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        directories.push(PathBuf::from(user).join(".cargo/bin"));
    }
    #[cfg(windows)]
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(program_files).join("LLVM/bin"));
    }
    #[cfg(target_os = "macos")]
    directories.extend([
        PathBuf::from("/opt/homebrew/opt/llvm/bin"),
        PathBuf::from("/usr/local/opt/llvm/bin"),
    ]);
    directories.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    find_in(
        &std::env::join_paths(directories).ok()?,
        OsStr::new(program),
        std::env::var_os("PATHEXT").as_deref(),
    )
}

pub fn tools(home: &Path) -> Vec<LanguageTool> {
    let saved = configurations(home);
    let prefix = home
        .join("tools/language-servers")
        .to_string_lossy()
        .replace('"', "");
    LANGUAGES
        .iter()
        .map(|(id, name, command, args)| {
            let config = saved
                .get(*id)
                .cloned()
                .unwrap_or_else(|| LanguageServerConfig {
                    command: command.to_string(),
                    args: args.iter().map(|s| s.to_string()).collect(),
                    interpreter: None,
                });
            let resolved = resolve(&config.command, home);
            let install_command = match *id {
                "python" => format!("npm install --prefix \"{prefix}\" pyright@1.1.414"),
                "typescript" => format!(
                    "npm install --prefix \"{prefix}\" typescript@6.0.3 typescript-language-server@6.0.2"
                ),
                "rust" => "rustup component add rust-analyzer".into(),
                _ if cfg!(windows) => "winget install --id LLVM.LLVM --exact".into(),
                _ if cfg!(target_os = "macos") => "brew install llvm".into(),
                _ => "sudo apt install clangd".into(),
            };
            let documentation = match *id {
                "python" => "https://github.com/microsoft/pyright/blob/main/docs/installation.md",
                "typescript" => {
                    "https://github.com/typescript-language-server/typescript-language-server"
                }
                "rust" => "https://rust-analyzer.github.io/book/installation.html",
                _ => "https://clangd.llvm.org/installation",
            };
            LanguageTool {
                language: id.to_string(),
                name: name.to_string(),
                installed: resolved.is_some(),
                resolved_path: resolved.map(|p| p.to_string_lossy().into_owned()),
                config,
                install_command,
                documentation: documentation.into(),
            }
        })
        .collect()
}

pub fn configure(home: &Path, language: &str, config: LanguageServerConfig) -> Result<()> {
    definition(language)?;
    if config.command.trim().is_empty()
        || config.command.contains(['\n', '\r', '\0'])
        || config.args.iter().any(|a| a.contains('\0'))
    {
        return Err(failure("Enter an executable path and valid arguments."));
    }
    let path = home.join("language-servers.json");
    let mut saved: HashMap<String, LanguageServerConfig> = if path.exists() {
        serde_json::from_slice(&std::fs::read(&path).map_err(failure)?)
            .map_err(|e| failure(format!("Repair language-servers.json before saving: {e}")))?
    } else {
        HashMap::new()
    };
    saved.insert(language.into(), config);
    let mut file = tempfile::NamedTempFile::new_in(home).map_err(failure)?;
    file.write_all(&serde_json::to_vec_pretty(&saved).map_err(failure)?)
        .map_err(failure)?;
    file.persist(home.join("language-servers.json"))
        .map_err(failure)?;
    Ok(())
}

pub struct LanguageServers {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    install_lock: Mutex<()>,
}
impl Default for LanguageServers {
    fn default() -> Self {
        Self {
            next_id: AtomicU32::new(1),
            sessions: Mutex::new(HashMap::new()),
            install_lock: Mutex::new(()),
        }
    }
}
struct Session {
    root: PathBuf,
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    registry: Arc<ProcessRegistry>,
    pid: i32,
}
impl Session {
    fn stop(&self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        terminate_group(self.pid, SHUTDOWN_GRACE, || {
            let _ = child.try_wait();
        });
        let _ = child.wait();
        release_job(self.pid);
        self.registry.unregister(self.pid);
    }
}
impl LanguageServers {
    pub fn configure(
        &self,
        home: &Path,
        language: &str,
        config: LanguageServerConfig,
    ) -> Result<()> {
        let _lock = self.install_lock.lock().unwrap_or_else(|e| e.into_inner());
        configure(home, language, config)
    }
    pub fn install(
        &self,
        home: &Path,
        language: &str,
        progress: impl Fn(&str),
    ) -> Result<LanguageTool> {
        definition(language)?;
        let _lock = self.install_lock.lock().unwrap_or_else(|e| e.into_inner());
        crate::language_install::install(home, language, &progress)?;
        tools(home)
            .into_iter()
            .find(|t| t.language == language)
            .ok_or_else(|| failure("Unknown language"))
    }
    pub fn start(
        &self,
        home: &Path,
        root: &Path,
        language: &str,
        registry: Arc<ProcessRegistry>,
    ) -> Result<(LanguageServerSummary, Receiver<String>)> {
        definition(language)?;
        let tool = tools(home)
            .into_iter()
            .find(|t| t.language == language)
            .unwrap();
        let executable = tool.resolved_path.ok_or_else(|| {
            failure(format!(
                "{} is not installed. Open Language tools to install or configure it.",
                tool.name
            ))
        })?;
        let mut command = Command::new(&executable);
        command
            .args(tool.config.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let node = home.join("tools/node");
        let mut paths = vec![node.clone(), node.join("bin")];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
        let mut child = spawn_in_own_group(&mut command).spawn().map_err(failure)?;
        attach_child_to_job(&mut child).map_err(failure)?;
        let pid = child.id() as i32;
        registry.register(pid, &executable);
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let session = Arc::new(Session {
            root: root.to_path_buf(),
            child: Mutex::new(child),
            input: Mutex::new(input),
            registry,
            pid,
        });
        let (sender, receiver) = bounded(128);
        let errors = sender.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            while let Ok(Some(message)) = read_message(&mut reader) {
                if sender.send(message).is_err() {
                    return;
                }
            }
            let _ = sender.send(
                serde_json::json!({"jsonrpc":"2.0", "method":"$/oxide/serverExited", "params":{}})
                    .to_string(),
            );
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if errors.send(serde_json::json!({"jsonrpc":"2.0", "method":"window/logMessage", "params":{"type":4,"message":line.chars().take(2000).collect::<String>()}}).to_string()).is_err() { break; }
            }
        });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, session);
        Ok((
            LanguageServerSummary {
                id,
                root: root.to_string_lossy().into_owned(),
                language: language.into(),
                initialization_options: if language == "typescript" {
                    let local = root.join("node_modules/typescript/lib/tsserver.js");
                    let managed =
                        home.join("tools/language-servers/node_modules/typescript/lib/tsserver.js");
                    let sdk = if local.is_file() {
                        Some(local)
                    } else if managed.is_file() {
                        Some(managed)
                    } else {
                        None
                    };
                    serde_json::json!({"hostInfo":"oxide","tsserver":{"path":sdk.map(|path| path.to_string_lossy().into_owned())}}).to_string()
                } else {
                    "{}".into()
                },
            },
            receiver,
        ))
    }
    pub fn send(&self, id: u32, message: &str) -> Result<()> {
        if message.len() > MAX_MESSAGE {
            return Err(failure("Language server message is too large."));
        }
        serde_json::from_str::<serde_json::Value>(message).map_err(failure)?;
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| failure("Language server stopped."))?;
        let mut input = session.input.lock().unwrap_or_else(|e| e.into_inner());
        write!(
            input,
            "Content-Length: {}\r\n\r\n{}",
            message.len(),
            message
        )
        .and_then(|_| input.flush())
        .map_err(failure)
    }
    pub fn stop(&self, id: u32) {
        if let Some(session) = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
        {
            session.stop();
        }
    }
    pub fn stop_root(&self, root: &Path) {
        let sessions: Vec<_> = {
            let mut active = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            let ids: Vec<_> = active
                .iter()
                .filter(|(_, session)| session.root.starts_with(root))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| active.remove(&id))
                .collect()
        };
        for session in sessions {
            session.stop();
        }
    }
    pub fn shutdown(&self) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.stop();
        }
    }
}

/// LSP headers may include Content-Type. Length is in bytes and may span arbitrary pipe reads.
fn read_message(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut length = None;
    let mut total = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            return Ok(None);
        }
        total += header.len();
        if total > 8192 {
            return Err(std::io::Error::other("LSP header too large"));
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.eq_ignore_ascii_case("Content-Length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let length = length
        .filter(|n| *n <= MAX_MESSAGE)
        .ok_or_else(|| std::io::Error::other("Invalid LSP Content-Length"))?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_utf8_byte_lengths_multiple_messages_and_content_type() {
        let first = "{\"text\":\"è\"}";
        let wire = format!(
            "Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}Content-Length: 2\r\n\r\n{{}}",
            first.len(),
            first
        );
        let mut reader = std::io::Cursor::new(wire);
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some(first));
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some("{}"));
        assert!(read_message(&mut reader).unwrap().is_none());
    }
    #[test]
    fn rejects_unbounded_messages_and_invalid_utf8() {
        assert!(
            read_message(&mut std::io::Cursor::new(
                "Content-Length: 999999999\r\n\r\n"
            ))
            .is_err()
        );
        assert!(read_message(&mut std::io::Cursor::new(b"Content-Length: 1\r\n\r\n\xff")).is_err());
    }
}
