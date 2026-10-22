use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a completed, idle Thread keeps its Provider process before Core shuts it down.
pub const PROVIDER_IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The source of time for idle reaping, injectable so tests need not wait 10 minutes.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// A clock that only moves when told to.
pub struct ManualClock {
    start: Instant,
    elapsed: Mutex<Duration>,
}

impl ManualClock {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            elapsed: Mutex::new(Duration::ZERO),
        }
    }

    pub fn advance(&self, by: Duration) {
        *self.elapsed.lock().unwrap_or_else(|e| e.into_inner()) += by;
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        self.start + *self.elapsed.lock().unwrap_or_else(|e| e.into_inner())
    }
}
