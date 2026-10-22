use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
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
    pub fn start(id: u32, cwd: &Path) -> Result<Self> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Terminal(format!("open terminal: {e}")))?;
        let command = shell_command(cwd);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| Error::Terminal(format!("start terminal shell: {e}")))?;
        let pid = child.process_id().unwrap_or_default();
        #[cfg(unix)]
        let process_group = pair.master.process_group_leader().unwrap_or(pid as i32);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| Error::Terminal(format!("read terminal output: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))?;
        let subscribers = Arc::new(Mutex::new(Vec::<Sender<Vec<u8>>>::new()));
        let output_subscribers = Arc::clone(&subscribers);
        std::thread::spawn(move || read_output(reader, output_subscribers));
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
                        kill_session_processes(process_group);
                        #[cfg(not(unix))]
                        {
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
                cwd: cwd.to_string_lossy().into_owned(),
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

fn shell_command(cwd: &Path) -> portable_pty::CommandBuilder {
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(not(windows))]
    let mut command =
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into()));
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command
}

fn read_output(mut reader: Box<dyn Read + Send>, subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>) {
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
}

pub fn next_id(counter: &AtomicU32) -> u32 {
    counter.fetch_add(1, Ordering::Relaxed)
}
