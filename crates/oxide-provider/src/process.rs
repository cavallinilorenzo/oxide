//! Process hygiene shared by every child Oxide spawns (Provider CLIs, PTY shells): each runs in
//! its own process group, shutdown escalates SIGTERM -> SIGKILL, and live groups are recorded on
//! disk so a crashed Oxide's orphans can be killed on the next launch.

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// How long a process group gets between SIGTERM and SIGKILL.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Makes `command` start in a new process group led by the child (pgid == pid).
pub fn spawn_in_own_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

/// Whether any process of group `pgid` still exists (zombies included).
#[cfg(unix)]
pub fn group_alive(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }
    let rc = unsafe { libc::kill(-pgid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn group_alive(_pgid: i32) -> bool {
    false
}

/// Sends SIGTERM to the group, then SIGKILL once `grace` has passed with members still alive.
/// `reap` runs on every poll so the caller can `wait` on the group leader (a zombie leader
/// would otherwise keep the group looking alive). Returns once the group is gone.
#[cfg(unix)]
pub fn terminate_group(pgid: i32, grace: Duration, mut reap: impl FnMut()) {
    if pgid <= 0 {
        return;
    }
    unsafe { libc::kill(-pgid, libc::SIGTERM) };
    let deadline = Instant::now() + grace;
    let mut killed = false;
    loop {
        reap();
        if !group_alive(pgid) {
            return;
        }
        if !killed && Instant::now() >= deadline {
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
            killed = true;
        }
        // After SIGKILL the group dies at once; this bound only guards against uninterruptible
        // processes.
        if killed && Instant::now() >= deadline + Duration::from_secs(5) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(unix))]
pub fn terminate_group(_pgid: i32, _grace: Duration, _reap: impl FnMut()) {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    pgid: i32,
    /// The executable the group leader was started from, as given to the spawn call.
    executable: String,
}

/// The runtime file of live process-group ids (`~/.oxide/processes.json`).
///
/// Opening it loads what a previous run left behind as *stale*; [`reap_stale`](Self::reap_stale)
/// kills the stale groups whose leader still runs the expected executable. Writes are
/// best-effort: failing to record a group must never stop a Provider from starting.
pub struct ProcessRegistry {
    path: PathBuf,
    state: Mutex<RegistryState>,
}

#[derive(Default)]
struct RegistryState {
    live: Vec<Entry>,
    stale: Vec<Entry>,
}

impl ProcessRegistry {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let stale = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(RegistryState {
                live: Vec::new(),
                stale,
            }),
        }
    }

    /// Records a live group. `pgid` is the leader's pid.
    pub fn register(&self, pgid: i32, executable: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.live.retain(|e| e.pgid != pgid);
        state.live.push(Entry {
            pgid,
            executable: executable.to_string(),
        });
        self.persist(&state);
    }

    pub fn unregister(&self, pgid: i32) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.live.retain(|e| e.pgid != pgid);
        self.persist(&state);
    }

    /// Kills every group left by a previous run whose leader is still alive and still runs the
    /// recorded executable; a pid the OS has since reused for something else is left alone.
    /// Returns the killed group ids and forgets all stale entries.
    pub fn reap_stale(&self) -> Vec<i32> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let stale = std::mem::take(&mut state.stale);
        let mut killed = Vec::new();
        for entry in stale {
            if leader_runs(entry.pgid, &entry.executable) {
                terminate_group(entry.pgid, SHUTDOWN_GRACE, || {});
                killed.push(entry.pgid);
            }
        }
        self.persist(&state);
        killed
    }

    fn persist(&self, state: &RegistryState) {
        let Ok(json) = serde_json::to_vec(&state.live) else {
            return;
        };
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}

/// Whether `pid` leads its own process group and its command line starts with `executable`
/// (directly, or as the script of an interpreter such as `node claude`).
#[cfg(unix)]
fn leader_runs(pid: i32, executable: &str) -> bool {
    if pid <= 0 || unsafe { libc::getpgid(pid) } != pid {
        return false;
    }
    let Ok(output) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
    else {
        return false;
    };
    let wanted = base_name(executable);
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .take(2)
        .any(|token| base_name(token) == wanted)
}

#[cfg(not(unix))]
fn leader_runs(_pid: i32, _executable: &str) -> bool {
    false
}

#[cfg(unix)]
fn base_name(token: &str) -> &str {
    let name = Path::new(token)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(token);
    // Login shells show up as `-zsh`.
    name.trim_start_matches('-')
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    fn spawn_sleeper(program: &str) -> std::process::Child {
        let mut cmd = Command::new(program);
        cmd.arg("300").stdout(Stdio::null()).stderr(Stdio::null());
        spawn_in_own_group(&mut cmd).spawn().unwrap()
    }

    fn wait_gone(pgid: i32, child: &mut std::process::Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let _ = child.try_wait();
            if !group_alive(pgid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn child_leads_its_own_group() {
        let mut child = spawn_sleeper("sleep");
        let pid = child.id() as i32;
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        assert!(wait_gone(pid, &mut child));
    }

    #[test]
    fn terminate_group_uses_sigterm_first() {
        let mut child = spawn_sleeper("sleep");
        let pid = child.id() as i32;
        let started = Instant::now();
        terminate_group(pid, SHUTDOWN_GRACE, || {
            let _ = child.try_wait();
        });
        assert!(!group_alive(pid));
        assert!(started.elapsed() < SHUTDOWN_GRACE, "SIGTERM was enough");
    }

    #[test]
    fn terminate_group_escalates_to_sigkill_for_a_process_ignoring_sigterm() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "trap '' TERM; sleep 300 & wait"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = spawn_in_own_group(&mut cmd).spawn().unwrap();
        let pid = child.id() as i32;
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        terminate_group(pid, Duration::from_millis(500), || {
            let _ = child.try_wait();
        });

        assert!(!group_alive(pid), "leader and its sleep child must be gone");
        assert!(started.elapsed() >= Duration::from_millis(500));
    }

    #[test]
    fn reap_stale_kills_groups_whose_leader_matches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("processes.json");
        let mut orphan = spawn_sleeper("sleep");
        let pid = orphan.id() as i32;
        // The crashed run registered the group and never unregistered it.
        ProcessRegistry::open(&path).register(pid, "sleep");

        let killed = ProcessRegistry::open(&path).reap_stale();

        assert_eq!(killed, vec![pid]);
        assert!(wait_gone(pid, &mut orphan));
    }

    #[test]
    fn reap_stale_leaves_a_reused_pid_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("processes.json");
        let mut bystander = spawn_sleeper("sleep");
        let pid = bystander.id() as i32;
        ProcessRegistry::open(&path).register(pid, "/usr/local/bin/claude");

        let killed = ProcessRegistry::open(&path).reap_stale();

        assert!(killed.is_empty());
        assert!(group_alive(pid));
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        assert!(wait_gone(pid, &mut bystander));
    }

    #[test]
    fn reap_stale_forgets_entries_and_unregistered_groups_are_not_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("processes.json");
        let registry = ProcessRegistry::open(&path);
        registry.register(4_000_001, "sleep");
        registry.register(4_000_002, "sleep");
        registry.unregister(4_000_001);

        let next = ProcessRegistry::open(&path);
        assert_eq!(next.state.lock().unwrap().stale.len(), 1);
        next.reap_stale();
        assert!(
            ProcessRegistry::open(&path)
                .state
                .lock()
                .unwrap()
                .stale
                .is_empty()
        );
    }
}
