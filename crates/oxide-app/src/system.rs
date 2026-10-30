//! The host shell integration of Core's activity: activity assertions, notifications,
//! opening URLs and files, and the window badge.

use oxide_core::{Notification, NotificationKind, System};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct HostSystem {
    app: AppHandle,
    #[cfg(target_os = "macos")]
    activity: std::sync::Mutex<Option<ActivityToken>>,
    #[cfg(target_os = "windows")]
    activity: std::sync::Mutex<Option<WindowsActivityToken>>,
}

pub type MacSystem = HostSystem;

impl HostSystem {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            #[cfg(target_os = "macos")]
            activity: std::sync::Mutex::new(None),
            #[cfg(target_os = "windows")]
            activity: std::sync::Mutex::new(None),
        }
    }
}

impl System for HostSystem {
    #[cfg(target_os = "macos")]
    fn hold_activity(&self) {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
        let mut held = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if held.is_none() {
            // User-initiated work keeps the app out of App Nap; idle system sleep stays allowed.
            let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str("A Thread is working"),
            );
            *held = Some(ActivityToken(token));
        }
    }

    #[cfg(target_os = "macos")]
    fn release_activity(&self) {
        use objc2_foundation::NSProcessInfo;
        if let Some(token) = self
            .activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            // SAFETY: the token came from `beginActivityWithOptions:reason:`.
            unsafe { NSProcessInfo::processInfo().endActivity(&token.0) };
        }
    }

    #[cfg(target_os = "windows")]
    fn hold_activity(&self) {
        let mut held = self.activity.lock().unwrap_or_else(|e| e.into_inner());
        if held.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let thread = std::thread::Builder::new()
                .name("oxide-activity-hold".into())
                .spawn(move || {
                    use windows_sys::Win32::System::Power::{
                        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
                    };
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                    }
                    let _ = rx.recv();
                    unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS);
                    }
                });
            match thread {
                Ok(handle) => {
                    *held = Some(WindowsActivityToken {
                        _stop: tx,
                        _handle: Some(handle),
                    });
                }
                Err(err) => {
                    eprintln!("Failed to spawn thread for activity hold: {err}");
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    fn release_activity(&self) {
        if let Some(mut token) = self
            .activity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = token._stop.send(());
            if let Some(handle) = token._handle.take() {
                let _ = handle.join();
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn hold_activity(&self) {}

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn release_activity(&self) {}

    fn notify(&self, notification: Notification) {
        let body = match notification.kind {
            NotificationKind::NeedsInput => "A Thread needs your input",
            NotificationKind::Completed => "A Thread finished",
        };
        let _ = self
            .app
            .notification()
            .builder()
            .title("Oxide")
            .body(body)
            .show();
    }

    fn open_url(&self, url: &str) {
        // Core only passes https URLs it read from `gh`.
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(url).spawn();

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::UI::Shell::ShellExecuteW;

            let wide_url: Vec<u16> = std::ffi::OsStr::new(url)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let wide_op: Vec<u16> = std::ffi::OsStr::new("open")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: ShellExecuteW is called with valid null-terminated UTF-16 strings.
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    wide_op.as_ptr(),
                    wide_url.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1, // SW_SHOWNORMAL
                )
            };
            if (result as usize) <= 32 {
                let _ = std::process::Command::new("rundll32")
                    .args(["url.dll,FileProtocolHandler", url])
                    .spawn();
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }

    #[cfg(target_os = "macos")]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        let _ = std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn();
    }

    #[cfg(target_os = "windows")]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        let path_str = path.to_string_lossy().replace('/', "\\");
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{path_str}"))
            .spawn();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn reveal_in_finder(&self, path: &std::path::Path) {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }

    fn set_badge(&self, count: u32) {
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.set_badge_count((count > 0).then_some(i64::from(count)));
        }
    }
}

/// An `NSProcessInfo` activity token. The object is thread-safe; `endActivity:` may be
/// called from any thread.
#[cfg(target_os = "macos")]
struct ActivityToken(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
);

#[cfg(target_os = "macos")]
unsafe impl Send for ActivityToken {}

#[cfg(target_os = "windows")]
struct WindowsActivityToken {
    _stop: std::sync::mpsc::Sender<()>,
    _handle: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_os = "windows")]
impl Drop for WindowsActivityToken {
    fn drop(&mut self) {
        let _ = self._stop.send(());
        if let Some(handle) = self._handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn activity_token_lifecycle_controls_execution_state() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let handle = std::thread::spawn(move || {
            use windows_sys::Win32::System::Power::{
                ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
            };
            let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
            assert_ne!(prev, 0, "SetThreadExecutionState must succeed");
            let _ = rx.recv();
            let restored = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            assert_ne!(
                restored, 0,
                "SetThreadExecutionState must succeed on release"
            );
        });
        let mut token = Some(WindowsActivityToken {
            _stop: tx,
            _handle: Some(handle),
        });

        assert!(token.is_some());
        drop(token.take());
        assert!(token.is_none());
    }
}
