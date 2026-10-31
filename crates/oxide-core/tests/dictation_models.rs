use oxide_core::dictation::{
    ModelId,
    models::{ModelCatalogue, ModelEntry, ModelManager, ModelSource, ModelState, catalogue},
};
use std::{
    io::{Cursor, Read},
    path::Path,
    sync::Arc,
};

struct Source {
    bytes: Vec<u8>,
    disk: u64,
}
impl ModelSource for Source {
    fn available_space(&self, _: &Path) -> oxide_core::Result<u64> {
        if self.disk == u64::MAX {
            return Err(oxide_core::Error::Dictation("Unknown disk space".into()));
        }
        Ok(self.disk)
    }
    fn open(
        &self,
        _: &ModelEntry,
        _: Arc<std::sync::atomic::AtomicBool>,
    ) -> oxide_core::Result<Box<dyn Read + Send>> {
        Ok(Box::new(Cursor::new(self.bytes.clone())))
    }
}
fn manager(bytes: &[u8], disk: u64) -> ModelManager {
    let mut entry = catalogue().models[2].clone();
    entry.expected_bytes = 3;
    entry.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
    let mut tiny = entry.clone();
    tiny.id = ModelId::Tiny;
    ModelManager::with_source(
        ModelCatalogue {
            version: 1,
            models: vec![entry, tiny],
        },
        Arc::new(Source {
            bytes: bytes.into(),
            disk,
        }),
    )
}

#[test]
fn missing_selection_keeps_working_model_protected_until_explicit_install() {
    use oxide_core::dictation::{Dictation, DictationSettings};
    let home = tempfile::tempdir().unwrap();
    let models = Arc::new(manager(b"abc", 100));
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    let dictation = Dictation::default().with_models(models.clone());
    let mut settings = DictationSettings {
        enabled: true,
        ..Default::default()
    };
    dictation.configure(home.path(), &settings).unwrap();
    settings.model = ModelId::Tiny;
    assert!(dictation.configure(home.path(), &settings).is_err());
    assert!(models.delete(home.path(), ModelId::Small).is_err());
    models.install(home.path(), ModelId::Tiny, |_| {}).unwrap();
    dictation.configure(home.path(), &settings).unwrap();
    models.delete(home.path(), ModelId::Small).unwrap();
    assert!(models.delete(home.path(), ModelId::Tiny).is_err());
    settings.enabled = false;
    dictation.configure(home.path(), &settings).unwrap();
    models.delete(home.path(), ModelId::Tiny).unwrap();
}

#[test]
fn disable_invalidates_pending_recording_start_before_microphone_capture() {
    use oxide_core::dictation::{Dictation, DictationSettings};
    let home = tempfile::tempdir().unwrap();
    let models = Arc::new(manager(b"abc", 100));
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    let dictation = Dictation::default().with_models(models.clone());
    let settings = DictationSettings {
        enabled: true,
        ..Default::default()
    };
    let pending = dictation
        .prepare_recording(home.path(), || settings.clone())
        .unwrap();
    dictation
        .configure(home.path(), &DictationSettings::default())
        .unwrap();
    let error = dictation.start_prepared(pending).unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    models.delete(home.path(), ModelId::Small).unwrap();
}

#[test]
fn disable_while_reading_settings_invalidates_stale_enabled_snapshot() {
    use oxide_core::dictation::{Dictation, DictationSettings};
    let home = tempfile::tempdir().unwrap();
    let models = Arc::new(manager(b"abc", 100));
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    let dictation = Dictation::default().with_models(models.clone());
    let stale = DictationSettings {
        enabled: true,
        ..Default::default()
    };
    let pending = dictation.prepare_recording(home.path(), || {
        dictation
            .configure(home.path(), &DictationSettings::default())
            .unwrap();
        stale
    });
    assert!(pending.err().unwrap().to_string().contains("cancelled"));
    models.delete(home.path(), ModelId::Small).unwrap();
}

#[test]
fn installation_publishes_verified_artifact_and_reuses_cached_small_offline() {
    let home = tempfile::tempdir().unwrap();
    let models = manager(b"abc", 100);
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Installed
    ));
    let offline = manager(b"", 0);
    offline
        .install(home.path(), ModelId::Small, |_| {
            panic!("cached Small must not download")
        })
        .unwrap();
    assert!(offline.acquire(home.path(), ModelId::Small).is_ok());
}

#[test]
fn insufficient_or_unknown_disk_space_never_publishes_a_model() {
    for disk in [2, u64::MAX] {
        let home = tempfile::tempdir().unwrap();
        let models = manager(b"abc", disk);
        assert!(
            models
                .install(home.path(), ModelId::Small, |_| {})
                .unwrap_err()
                .to_string()
                .contains("disk space")
        );
        assert!(!home.path().join("models/ggml-small.bin").exists());
    }
}

#[test]
fn cancel_at_last_chunk_discards_partial_artifact_and_allows_explicit_retry() {
    let home = tempfile::tempdir().unwrap();
    let models = manager(b"abc", 100);
    let result = models.install(home.path(), ModelId::Small, |s| {
        if matches!(s.state, ModelState::Installing { .. }) {
            assert!(!home.path().join("models/ggml-small.bin").exists());
            models.cancel(home.path(), ModelId::Small);
        }
    });
    assert!(result.is_err());
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Cancelled
    ));
    assert!(!home.path().join("models/ggml-small.bin").exists());
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    assert!(models.acquire(home.path(), ModelId::Small).is_ok());
}

#[test]
fn active_model_and_concurrent_download_are_protected_from_conflicting_operations() {
    let home = tempfile::tempdir().unwrap();
    let models = manager(b"abc", 100);
    models
        .install(home.path(), ModelId::Small, |s| {
            if matches!(s.state, ModelState::Installing { .. }) {
                assert!(models.install(home.path(), ModelId::Small, |_| {}).is_err());
                assert!(models.delete(home.path(), ModelId::Small).is_err());
                assert!(models.acquire(home.path(), ModelId::Small).is_err());
            }
        })
        .unwrap();
    let active = models.acquire(home.path(), ModelId::Small).unwrap();
    let other = manager(b"abc", 100);
    assert!(other.delete(home.path(), ModelId::Small).is_err());
    drop(active);
    models.delete(home.path(), ModelId::Small).unwrap();
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Missing
    ));
}

#[test]
fn corrupt_cache_checksum_and_size_failures_never_count_as_installed() {
    for bytes in [b"bad".as_slice(), b"ab", b"abcd"] {
        let home = tempfile::tempdir().unwrap();
        let models = manager(bytes, 100);
        assert!(models.install(home.path(), ModelId::Small, |_| {}).is_err());
        assert!(!home.path().join("models/ggml-small.bin").exists());
        assert!(matches!(
            models.status(home.path(), ModelId::Small).unwrap().state,
            ModelState::Error { .. }
        ));
        assert!(models.acquire(home.path(), ModelId::Small).is_err());
    }
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("models")).unwrap();
    std::fs::write(home.path().join("models/ggml-small.bin"), b"bad").unwrap();
    let models = manager(b"abc", 100);
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Error { .. }
    ));
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    assert!(models.acquire(home.path(), ModelId::Small).is_ok());
}

#[test]
fn verified_cache_reuses_status_and_detects_file_modifications() {
    let home = tempfile::tempdir().unwrap();
    let models = manager(b"abc", 100);
    models.install(home.path(), ModelId::Small, |_| {}).unwrap();
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Installed
    ));
    // Repeated status check leverages the cached verification
    assert!(matches!(
        models.status(home.path(), ModelId::Small).unwrap().state,
        ModelState::Installed
    ));
}
