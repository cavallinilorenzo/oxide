//! What the running Threads mean for the operating system: the App Nap activity assertion,
//! notifications and the Dock badge. Core decides when; the shell supplies the [`System`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::thread::ThreadStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationKind {
    NeedsInput,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notification {
    pub thread_id: u32,
    pub kind: NotificationKind,
}

/// The operating-system side of Core's activity, injected by the App shell.
pub trait System: Send + Sync + 'static {
    /// A Turn started working: keep the app out of App Nap. System sleep stays allowed.
    fn hold_activity(&self);
    /// No Turn is working any more.
    fn release_activity(&self);
    fn notify(&self, notification: Notification);
    /// The number of Threads in needs input.
    fn set_badge(&self, count: u32);
    /// Opens a web page in the user's browser.
    fn open_url(&self, _url: &str) {}
    /// Whether the macOS app with this bundle identifier is installed.
    fn is_app_installed(&self, _bundle_id: &str) -> bool {
        false
    }
    /// Opens a folder in the app with this bundle identifier.
    fn open_with_app(&self, _bundle_id: &str, _path: &Path) {}
    /// Shows a file or folder in Finder.
    fn reveal_in_finder(&self, _path: &Path) {}
}

struct NoSystem;

impl System for NoSystem {
    fn hold_activity(&self) {}
    fn release_activity(&self) {}
    fn notify(&self, _: Notification) {}
    fn set_badge(&self, _: u32) {}
}

#[derive(Default)]
struct Tracked {
    statuses: HashMap<u32, ThreadStatus>,
    held: bool,
    badge: u32,
}

/// Live Thread statuses, fed by the Thread actors.
pub struct Activity {
    tracked: Mutex<Tracked>,
    system: Mutex<Arc<dyn System>>,
    window_active: AtomicBool,
}

impl Activity {
    pub(crate) fn new() -> Self {
        Self {
            tracked: Mutex::default(),
            system: Mutex::new(Arc::new(NoSystem)),
            window_active: AtomicBool::new(true),
        }
    }

    pub(crate) fn set_system(&self, system: Arc<dyn System>) {
        *self.system.lock().unwrap_or_else(|e| e.into_inner()) = system;
        // Bring a late-installed system up to date.
        let mut tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
        tracked.held = false;
        tracked.badge = 0;
        self.sync(&mut tracked);
    }

    /// The window is visible and focused.
    pub(crate) fn set_window_active(&self, active: bool) {
        self.window_active.store(active, Ordering::Relaxed);
    }

    pub(crate) fn set_status(&self, thread_id: u32, status: ThreadStatus) {
        let mut tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
        let previous = tracked.statuses.insert(thread_id, status);
        self.sync(&mut tracked);
        let kind = match status {
            ThreadStatus::NeedsInput => NotificationKind::NeedsInput,
            ThreadStatus::Completed => NotificationKind::Completed,
            _ => return,
        };
        if previous != Some(status) && !self.window_active.load(Ordering::Relaxed) {
            self.system().notify(Notification { thread_id, kind });
        }
    }

    pub(crate) fn forget(&self, thread_id: u32) {
        let mut tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
        tracked.statuses.remove(&thread_id);
        self.sync(&mut tracked);
    }

    /// Threads with a Turn in flight: working or waiting on the user.
    pub(crate) fn active_count(&self) -> u32 {
        let tracked = self.tracked.lock().unwrap_or_else(|e| e.into_inner());
        count(&tracked, |s| {
            matches!(s, ThreadStatus::Working | ThreadStatus::NeedsInput)
        })
    }

    fn sync(&self, tracked: &mut Tracked) {
        let working = count(tracked, |s| s == ThreadStatus::Working) > 0;
        let needs_input = count(tracked, |s| s == ThreadStatus::NeedsInput);
        let system = self.system();
        if working != tracked.held {
            tracked.held = working;
            if working {
                system.hold_activity();
            } else {
                system.release_activity();
            }
        }
        if needs_input != tracked.badge {
            tracked.badge = needs_input;
            system.set_badge(needs_input);
        }
    }

    pub(crate) fn open_url(&self, url: &str) {
        self.system().open_url(url);
    }

    pub(crate) fn system(&self) -> Arc<dyn System> {
        self.system
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn count(tracked: &Tracked, f: impl Fn(ThreadStatus) -> bool) -> u32 {
    tracked.statuses.values().filter(|s| f(**s)).count() as u32
}
