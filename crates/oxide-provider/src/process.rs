//! Process hygiene shared by every child Oxide spawns (Provider CLIs, PTY shells): each runs in
//! its own process group, shutdown escalates SIGTERM -> SIGKILL, and live groups are recorded on
//! disk so a crashed Oxide's orphans can be killed on the next launch.

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// How long a process group gets between SIGTERM and SIGKILL.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Background CLI calls must not create a visible console in the Windows app.
pub fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    command
}

/// Makes `command` start in a new process group led by the child (pgid == pid).
/// Windows stdio children run without a console window; PTY shells own their console.
pub fn spawn_in_own_group(command: &mut Command) -> &mut Command {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP
                | windows_sys::Win32::System::Threading::CREATE_SUSPENDED
                | windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
        );
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

#[cfg(windows)]
pub fn group_alive(pgid: i32) -> bool {
    windows_process::group_alive(pgid)
}

#[cfg(not(any(unix, windows)))]
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

#[cfg(windows)]
pub fn terminate_group(pgid: i32, _grace: Duration, mut reap: impl FnMut()) {
    windows_process::terminate_group(pgid);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        reap();
        if !group_alive(pgid) || std::time::Instant::now() >= deadline {
            windows_process::close_job(pgid);
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(any(unix, windows)))]
pub fn terminate_group(_pgid: i32, _grace: Duration, _reap: impl FnMut()) {}

/// Attach a spawned child to a kill-on-close Windows Job Object. Descendants inherit the job,
/// so closing Oxide or terminating the leader also terminates its process tree.
#[cfg(windows)]
pub fn attach_to_job(pid: u32) -> std::io::Result<()> {
    windows_process::attach(pid as i32, true)
}

#[cfg(not(windows))]
pub fn attach_to_job(_pid: u32) -> std::io::Result<()> {
    Ok(())
}

/// Attach an already running child, such as a PTY shell, to a Windows Job Object.
#[cfg(windows)]
pub fn attach_running_to_job(pid: u32) -> std::io::Result<()> {
    windows_process::attach(pid as i32, false)
}

#[cfg(not(windows))]
pub fn attach_running_to_job(_pid: u32) -> std::io::Result<()> {
    Ok(())
}

/// Attach a suspended std child to its kill-on-close job before resuming it.
pub fn attach_child_to_job(child: &mut Child) -> std::io::Result<()> {
    if let Err(error) = attach_to_job(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(())
}

/// Releases the process job after a child has exited.
pub fn release_job(_pid: i32) {
    #[cfg(windows)]
    windows_process::close_job(_pid);
}

/// Captures a short-lived CLI invocation while keeping it in Oxide's process group/job.
pub fn output_in_own_group(command: &mut Command) -> std::io::Result<Output> {
    spawn_in_own_group(command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    #[cfg(windows)]
    let pid = child.id() as i32;
    let output = match attach_child_to_job(&mut child) {
        Ok(()) => child.wait_with_output(),
        Err(error) => return Err(error),
    };
    #[cfg(windows)]
    release_job(pid);
    output
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    pgid: i32,
    /// The executable the group leader was started from, as given to the spawn call.
    executable: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<ProcessIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ProcessIdentity {
    image: String,
    creation_time: u64,
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
        #[cfg(windows)]
        let _ = attach_running_to_job(pgid as u32);
        #[cfg(windows)]
        let identity = windows_process::process_identity(pgid);
        #[cfg(not(windows))]
        let identity = None;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.live.retain(|e| e.pgid != pgid);
        state.live.push(Entry {
            pgid,
            executable: executable.to_string(),
            identity,
        });
        self.persist(&state);
    }

    pub fn unregister(&self, pgid: i32) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.live.retain(|e| e.pgid != pgid);
        self.persist(&state);
        #[cfg(windows)]
        windows_process::close_job(pgid);
    }

    /// Kills every group left by a previous run whose leader is still alive and still runs the
    /// recorded executable; a pid the OS has since reused for something else is left alone.
    /// Returns the killed group ids and forgets all stale entries.
    pub fn reap_stale(&self) -> Vec<i32> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let stale = std::mem::take(&mut state.stale);
        let mut killed = Vec::new();
        for entry in stale {
            if leader_runs(entry.pgid, &entry.executable, entry.identity.as_ref()) {
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
fn leader_runs(pid: i32, executable: &str, _identity: Option<&ProcessIdentity>) -> bool {
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

#[cfg(windows)]
fn leader_runs(pid: i32, executable: &str, identity: Option<&ProcessIdentity>) -> bool {
    windows_process::leader_runs(pid, executable, identity)
}

#[cfg(not(any(unix, windows)))]
fn leader_runs(_pid: i32, _executable: &str, _identity: Option<&ProcessIdentity>) -> bool {
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

#[cfg(windows)]
mod windows_process {
    use super::ProcessIdentity;
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, QueryFullProcessImageNameW,
        ResumeThread, THREAD_SUSPEND_RESUME, WaitForSingleObject,
    };

    static JOBS: OnceLock<Mutex<HashMap<i32, usize>>> = OnceLock::new();

    fn jobs() -> &'static Mutex<HashMap<i32, usize>> {
        JOBS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn attach(pid: i32, resume_suspended: bool) -> io::Result<()> {
        if pid <= 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid process id",
            ));
        }
        if jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&pid)
        {
            return Ok(());
        }
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid as u32,
            );
            if process.is_null() {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            let assigned = AssignProcessToJobObject(job, process) != 0;
            let error = (!assigned).then(io::Error::last_os_error);
            CloseHandle(process);
            if let Some(error) = error {
                CloseHandle(job);
                return Err(error);
            }
            if resume_suspended {
                if let Err(error) = resume_primary_thread(pid as u32) {
                    CloseHandle(job);
                    return Err(error);
                }
            } else if let Err(error) = attach_existing_descendants(pid as u32, job) {
                CloseHandle(job);
                return Err(error);
            }
            let old = jobs()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(pid, job as usize);
            if let Some(old) = old {
                CloseHandle(old as HANDLE);
            }
            Ok(())
        }
    }

    unsafe fn attach_existing_descendants(root_pid: u32, job: HANDLE) -> io::Result<()> {
        let mut attached = HashSet::from([root_pid]);
        loop {
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
            if snapshot == -1_isize as HANDLE {
                return Err(io::Error::last_os_error());
            }
            let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut parents = Vec::new();
            let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
            while found {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
            }
            unsafe { CloseHandle(snapshot) };

            let mut descendants = HashSet::new();
            loop {
                let before = descendants.len();
                for &(pid, parent) in &parents {
                    if parent == root_pid || descendants.contains(&parent) {
                        descendants.insert(pid);
                    }
                }
                if descendants.len() == before {
                    break;
                }
            }
            let mut added = false;
            for pid in descendants
                .difference(&attached)
                .copied()
                .collect::<Vec<_>>()
            {
                attached.insert(pid);
                let process = unsafe {
                    OpenProcess(
                        PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        pid,
                    )
                };
                if process.is_null() {
                    continue;
                }
                let mut already_in_job = 0;
                let checked = unsafe { IsProcessInJob(process, job, &mut already_in_job) } != 0;
                let assigned = checked
                    && (already_in_job != 0
                        || unsafe { AssignProcessToJobObject(job, process) } != 0);
                unsafe { CloseHandle(process) };
                added |= assigned;
            }
            if !added {
                return Ok(());
            }
        }
    }

    unsafe fn resume_primary_thread(pid: u32) -> io::Result<()> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == -1_isize as HANDLE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut thread_id = None;
        let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == pid {
                thread_id = Some(entry.th32ThreadID);
                break;
            }
            found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        let Some(thread_id) = thread_id else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "suspended process thread was not found",
            ));
        };
        let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id) };
        if thread.is_null() {
            return Err(io::Error::last_os_error());
        }
        let resumed = unsafe { ResumeThread(thread) } != u32::MAX;
        let error = (!resumed).then(io::Error::last_os_error);
        unsafe { CloseHandle(thread) };
        error.map_or(Ok(()), Err)
    }

    pub(super) fn group_alive(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let jobs = jobs().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&job) = jobs.get(&pid) {
            let job = job as HANDLE;
            unsafe {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                return QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ) != 0
                    && accounting.ActiveProcesses != 0;
            }
        }
        unsafe {
            let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid as u32);
            if process.is_null() {
                return false;
            }
            let alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            CloseHandle(process);
            alive
        }
    }

    pub(super) fn terminate_group(pid: i32) {
        if pid <= 0 {
            return;
        }
        let job = jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .copied();
        if let Some(job) = job {
            let job = job as HANDLE;
            unsafe { TerminateJobObject(job, 1) };
            return;
        }
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid as u32);
            if !process.is_null() {
                windows_sys::Win32::System::Threading::TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }

    pub(super) fn close_job(pid: i32) {
        if let Some(job) = jobs()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid)
        {
            unsafe { CloseHandle(job as HANDLE) };
        }
    }

    pub(super) fn leader_runs(
        pid: i32,
        executable: &str,
        identity: Option<&ProcessIdentity>,
    ) -> bool {
        if pid <= 0 {
            return false;
        }
        let Some(actual_identity) = process_identity(pid) else {
            return false;
        };
        if identity.is_some_and(|identity| identity.creation_time != actual_identity.creation_time)
        {
            return false;
        }
        if let Some(identity) = identity {
            return identity.image.eq_ignore_ascii_case(&actual_identity.image);
        }
        let actual_name = actual_identity
            .image
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&actual_identity.image);
        let wanted = executable.rsplit(['\\', '/']).next().unwrap_or(executable);
        actual_name.eq_ignore_ascii_case(wanted)
    }

    pub(super) fn process_identity(pid: i32) -> Option<ProcessIdentity> {
        if pid <= 0 {
            return None;
        }
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if process.is_null() {
                return None;
            }
            let mut image = vec![0u16; 32_768];
            let mut length = image.len() as u32;
            let image_ok =
                QueryFullProcessImageNameW(process, 0, image.as_mut_ptr(), &mut length) != 0;
            let mut created = zeroed();
            let mut exited = zeroed();
            let mut kernel = zeroed();
            let mut user = zeroed();
            let times_ok =
                GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            CloseHandle(process);
            if !image_ok || !times_ok {
                return None;
            }
            let created: windows_sys::Win32::Foundation::FILETIME = created;
            let created = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
            Some(ProcessIdentity {
                image: String::from_utf16_lossy(&image[..length as usize]),
                creation_time: created,
            })
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::process::Stdio;

    #[test]
    fn background_command_has_no_console_window() {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command",
            "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'; [ConsoleProbe]::GetConsoleWindow().ToInt64()"]);
        let output = hide_console(&mut command).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0");
    }

    fn sleeper() -> std::process::Child {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/C", "ping -n 60 127.0.0.1 > NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = spawn_in_own_group(&mut command).spawn().unwrap();
        attach_to_job(child.id()).unwrap();
        child
    }

    #[test]
    fn job_group_can_be_observed_and_terminated() {
        let mut child = sleeper();
        let pid = child.id() as i32;
        assert!(group_alive(pid));

        terminate_group(pid, Duration::ZERO, || {
            let _ = child.try_wait();
        });

        let _ = child.wait();
        assert!(!group_alive(pid));
    }

    #[test]
    fn stale_registry_matches_wrapped_process_image_and_checks_creation_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("processes.json");
        let mut child = sleeper();
        let pid = child.id() as i32;
        let registry = ProcessRegistry::open(&path);
        registry.register(pid, "wrapped-cli.cmd");
        let mut entries: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        entries[0]["identity"]["creation_time"] =
            (entries[0]["identity"]["creation_time"].as_u64().unwrap() + 1).into();
        std::fs::write(&path, serde_json::to_vec(&entries).unwrap()).unwrap();

        assert!(ProcessRegistry::open(&path).reap_stale().is_empty());
        assert!(
            group_alive(pid),
            "a mismatched process identity must survive"
        );

        terminate_group(pid, Duration::ZERO, || {
            let _ = child.try_wait();
        });
        let _ = child.wait();
    }
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
