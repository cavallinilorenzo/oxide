use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use oxide_provider::process::ProcessRegistry;
#[cfg(unix)]
use oxide_provider::process::{SHUTDOWN_GRACE, terminate_group};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSummary {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
}

pub struct TerminalSession {
    pub summary: TerminalSummary,
    commands: Sender<SessionCommand>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
}

enum SessionCommand {
    Write(Vec<u8>, Sender<std::io::Result<()>>),
    Resize(PtySize, Sender<std::result::Result<(), String>>),
    Close(Sender<()>),
}

impl TerminalSession {
    pub fn run_block(&self, command: &str, token: &str) -> Result<()> {
        if token.is_empty()
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || command.len() > 64 * 1024
        {
            return Err(Error::Terminal(
                "Invalid command block or command exceeds 64 KiB.".into(),
            ));
        }
        #[cfg(windows)]
        let script = {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(command);
            format!(
                "[Console]::Clear(); $global:oxideCommandToken='{token}'; $global:oxideExitCode=$null; $global:LASTEXITCODE=0; $oxideOk=$true; [Console]::Write(([char]27)+']633;Oxide;{token};start'+[char]7); try {{ . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))); $oxideOk=$? }} catch {{ Write-Error $_; $oxideOk=$false }} finally {{ $global:oxideExitCode=if($oxideOk){{$global:LASTEXITCODE}}else{{if($global:LASTEXITCODE){{$global:LASTEXITCODE}}else{{1}}}} }}\r"
            )
        };
        #[cfg(not(windows))]
        let script = {
            let quoted = format!("'{}'", command.replace('\'', "'\"'\"'"));
            format!(
                "_oxide_token='{token}'; _oxide_exit=; printf '\\033]633;Oxide;{token};start\\007'; eval {quoted}; _oxide_exit=$?\n"
            )
        };
        self.write(script.as_bytes())
    }

    pub fn start(
        id: u32,
        cwd: &Path,
        registry: Arc<ProcessRegistry>,
        blocks: bool,
    ) -> Result<Self> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Terminal(format!("open terminal: {e}")))?;
        let command = shell_command(cwd, blocks);
        let shell = command
            .get_argv()
            .first()
            .map(|arg| arg.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| Error::Terminal(format!("start terminal shell: {e}")))?;
        let pid = child.process_id().unwrap_or_default();
        if let Err(error) = oxide_provider::process::attach_running_to_job(pid) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::Terminal(format!(
                "contain terminal shell process: {error}"
            )));
        }
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader().unwrap_or(pid as i32);
        // The PTY child is a session leader, so it also leads its own process group.
        #[cfg(unix)]
        registry.register(process_group, &shell);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::Terminal(format!("read terminal output: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))?;
        #[cfg(unix)]
        if blocks {
            // Start the interactive bash shell without an intermediate /bin/sh
            // so PS1 survives startup; keep Ctrl+C from terminating bash itself.
            writer
                .write_all(b"stty -echo\ntrap ':' INT\n")
                .and_then(|_| writer.flush())
                .map_err(|e| Error::Terminal(format!("configure terminal shell: {e}")))?;
        }
        let subscribers = Arc::new(Mutex::new(Vec::<Sender<Vec<u8>>>::new()));
        let output_subscribers = Arc::clone(&subscribers);
        std::thread::spawn(move || read_output(reader, output_subscribers, blocks));
        let (commands, receiver) = unbounded();
        std::thread::spawn(move || {
            let mut writer = writer;
            let master = pair.master;
            while let Ok(command) = receiver.recv() {
                match command {
                    SessionCommand::Write(input, reply) => {
                        let _ = reply.send(writer.write_all(&input).and_then(|_| writer.flush()));
                    }
                    SessionCommand::Resize(size, reply) => {
                        let result = master.resize(size).map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    SessionCommand::Close(reply) => {
                        #[cfg(unix)]
                        {
                            // Interactive shells ignore SIGTERM but hang up on SIGHUP.
                            unsafe { libc::kill(-process_group, libc::SIGHUP) };
                            terminate_group(process_group, SHUTDOWN_GRACE, || {
                                let _ = child.try_wait();
                            });
                            // Anything that moved to its own process group but stayed in the session.
                            kill_session_processes(process_group);
                            registry.unregister(process_group);
                        }
                        #[cfg(not(unix))]
                        {
                            let _ = (&registry, &shell);
                            let _ = child.kill();
                        }
                        let _ = child.wait();
                        let _ = reply.send(());
                        break;
                    }
                }
            }
        });
        Ok(Self {
            summary: TerminalSummary {
                id,
                pid,
                cwd: dunce::simplified(cwd).to_string_lossy().into_owned(),
            },
            commands,
            subscribers,
        })
    }

    pub fn subscribe(&self) -> Receiver<Vec<u8>> {
        let (tx, rx) = bounded(128);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        rx
    }

    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let (reply, result) = bounded(1);
        self.commands
            .send(SessionCommand::Write(bytes.to_vec(), reply))
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?;
        result
            .recv()
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let (reply, result) = bounded(1);
        self.commands
            .send(SessionCommand::Resize(
                PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                reply,
            ))
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?;
        result
            .recv()
            .map_err(|_| Error::Terminal("terminal actor stopped".into()))?
            .map_err(|e| Error::Terminal(format!("resize terminal: {e}")))
    }

    pub fn close(&self) {
        let (reply, result) = bounded(1);
        if self.commands.send(SessionCommand::Close(reply)).is_ok() {
            let _ = result.recv();
        }
    }
}

#[cfg(unix)]
fn kill_session_processes(session_id: i32) {
    if let Ok(output) = Command::new("ps").args(["-A", "-o", "pid="]).output() {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<i32>() {
                let sid = unsafe { libc::getsid(pid) };
                if sid == session_id {
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                }
            }
        }
    }
    unsafe { libc::kill(-session_id, libc::SIGKILL) };
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn shell_command(cwd: &Path, blocks: bool) -> portable_pty::CommandBuilder {
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(windows)]
    if blocks {
        // Use PowerShell's real REPL: Ctrl+C cancels a pipeline without killing the shell.
        command.args(["-NoLogo", "-NoExit", "-Command", r#"function global:prompt { if ($null -ne $global:oxideCommandToken) { $oxideCode=if($null -ne $global:oxideExitCode){$global:oxideExitCode}else{if($global:LASTEXITCODE){$global:LASTEXITCODE}else{1}}; [Console]::Write(([char]27)+"]633;Oxide;$($global:oxideCommandToken);end;$oxideCode;$($pwd.ProviderPath)"+[char]7); $global:oxideCommandToken=$null }; ' ' }"#]);
    }
    #[cfg(not(windows))]
    let mut command = CommandBuilder::new(if blocks {
        "/bin/bash".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    });
    #[cfg(not(windows))]
    if blocks {
        let prompt = r#"$(_oxide_prompt_status=$?; if [ -n "${_oxide_token-}" ]; then printf '\033]633;Oxide;%s;end;%s;%s\007' "$_oxide_token" "${_oxide_exit:-$_oxide_prompt_status}" "$PWD"; fi)"#;
        command.env("PS1", prompt);
        command.env("PS2", "");
        command.args(["--noprofile", "--norc", "-m", "-i"]);
    }
    command.cwd(dunce::simplified(cwd));
    command.env("TERM", "xterm-256color");
    command
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    blocks: bool,
) {
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let chunk = buffer[..count].to_vec();
                let mut subscribers = subscribers.lock().unwrap_or_else(|e| e.into_inner());
                subscribers.retain(|sender| sender.send(chunk.clone()).is_ok());
            }
        }
    }
    if blocks {
        let mut subscribers = subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subscribers.retain(|sender| sender.send(b"\x1b]633;Oxide;closed\x07".to_vec()).is_ok());
    }
}

pub fn next_id(counter: &AtomicU32) -> u32 {
    counter.fetch_add(1, Ordering::Relaxed)
}
