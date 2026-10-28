use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use oxide_provider::Detection;

/// How long a successful Provider detection is reused. Detecting spawns the Provider CLI.
const TTL: Duration = Duration::from_secs(60);

/// Remembers successful Provider detections for a short while, like `Gh` does for a passing
/// `gh auth status`. Only success is kept, so an install or login the user just fixed is
/// noticed on the next check.
#[derive(Default)]
pub(crate) struct DetectionCache {
    entries: Mutex<HashMap<String, (Instant, Detection)>>,
}

impl DetectionCache {
    /// The cached detection of `provider` while fresh, else whatever `detect` returns.
    pub(crate) fn get_or_detect(
        &self,
        provider: &str,
        detect: impl FnOnce() -> Detection,
    ) -> Detection {
        if let Some((at, det)) = self.entries.lock().unwrap().get(provider)
            && at.elapsed() < TTL
        {
            return det.clone();
        }
        let det = detect();
        if det.available {
            self.entries
                .lock()
                .unwrap()
                .insert(provider.to_string(), (Instant::now(), det.clone()));
        }
        det
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn detection(available: bool) -> Detection {
        Detection {
            available,
            installed: available,
            version: None,
            authenticated: available,
            warning: None,
        }
    }

    #[test]
    fn two_detections_within_the_ttl_spawn_the_cli_once() {
        let cache = DetectionCache::default();
        let spawned = Cell::new(0);
        for _ in 0..2 {
            let det = cache.get_or_detect("claude", || {
                spawned.set(spawned.get() + 1);
                detection(true)
            });
            assert!(det.available);
        }
        assert_eq!(spawned.get(), 1);
    }

    #[test]
    fn a_failed_detection_is_not_cached() {
        let cache = DetectionCache::default();
        let spawned = Cell::new(0);
        for _ in 0..2 {
            let det = cache.get_or_detect("claude", || {
                spawned.set(spawned.get() + 1);
                detection(false)
            });
            assert!(!det.available);
        }
        assert_eq!(spawned.get(), 2);
    }

    #[test]
    fn providers_are_cached_apart() {
        let cache = DetectionCache::default();
        cache.get_or_detect("claude", || detection(true));
        let det = cache.get_or_detect("codex", || detection(false));
        assert!(!det.available);
    }
}
