use crate::{Error, Result};
use crossbeam_channel::{Receiver, Sender, bounded};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
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
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    subscribers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    #[cfg(unix)]
    process_group: i32,
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
        let child = pair
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
        Ok(Self {
            summary: TerminalSummary {
                id,
                pid,
                cwd: cwd.to_string_lossy().into_owned(),
            },
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            subscribers,
            #[cfg(unix)]
            process_group,
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
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer
            .write_all(bytes)
            .and_then(|_| writer.flush())
            .map_err(|e| Error::Terminal(format!("write terminal input: {e}")))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| Error::Terminal(format!("resize terminal: {e}")))
    }

    pub fn close(&self) {
        #[cfg(unix)]
        {
            kill_session_processes(self.process_group);
            let _ = self.child.lock().unwrap_or_else(|e| e.into_inner()).wait();
        }
        #[cfg(not(unix))]
        {
            let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
            let _ = child.kill();
            let _ = child.wait();
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
