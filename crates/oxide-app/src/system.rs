//! The macOS side of Core's activity: the App Nap assertion, notifications and the Dock badge.

use oxide_core::{Notification, NotificationKind, System};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct MacSystem {
    app: AppHandle,
    #[cfg(target_os = "macos")]
    activity: std::sync::Mutex<Option<ActivityToken>>,
}

impl MacSystem {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            #[cfg(target_os = "macos")]
            activity: std::sync::Mutex::new(None),
        }
    }
}

impl System for MacSystem {
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

    #[cfg(not(target_os = "macos"))]
    fn hold_activity(&self) {}

    #[cfg(not(target_os = "macos"))]
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
