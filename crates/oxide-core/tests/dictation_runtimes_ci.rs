//! The core against bytes produced by the release tools (`tools/dictation-runtimes.mjs`).
//!
//! `tests/fixtures/runtimes/` is built by `node tools/checks/runtime-fixture.mjs write` with a
//! throwaway test key; a Node test fails when it stops matching what the tools produce. These tests
//! prove the other half: the index, signature and zips the CI makes are accepted, and any
//! alteration is refused.
use oxide_core::dictation::{
    BackendId,
    runtimes::{
        self, RUNTIME_INDEX_URL, RUNTIME_PUBLIC_KEY, RuntimeEntry, RuntimeManager, RuntimeSource,
    },
};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtimes")
}

fn fixture() -> HashMap<String, Vec<u8>> {
    std::fs::read_dir(fixture_dir())
        .unwrap()
        .flatten()
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

struct Published(HashMap<String, Vec<u8>>);

impl RuntimeSource for Published {
    fn index(&self) -> oxide_core::Result<(Vec<u8>, String)> {
        Ok((
            self.0["runtimes-index.json"].clone(),
            String::from_utf8(self.0["runtimes-index.json.minisig"].clone()).unwrap(),
        ))
    }
    fn open(
        &self,
        entry: &RuntimeEntry,
        _: Arc<AtomicBool>,
    ) -> oxide_core::Result<Box<dyn Read + Send>> {
        let name = entry.url.rsplit('/').next().unwrap();
        Ok(Box::new(Cursor::new(self.0[name].clone())))
    }
}

fn manager(files: HashMap<String, Vec<u8>>) -> RuntimeManager {
    let key = String::from_utf8(fixture()["public-key.txt"].clone())
        .unwrap()
        .trim()
        .to_string();
    RuntimeManager::new(Box::new(Published(files)), key).for_platform("windows-x86_64")
}

fn install(
    m: &RuntimeManager,
    dir: &Path,
    backend: BackendId,
) -> oxide_core::Result<runtimes::InstalledRuntime> {
    let result = m.install(dir, backend, Default::default(), |_, _| {});
    if result.is_err() {
        // A refused package leaves nothing behind.
        let left: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        assert!(
            left.iter()
                .all(|e| e.path().is_dir() && e.path().read_dir().unwrap().next().is_none()),
            "left behind: {left:?}"
        );
    }
    result
}

#[test]
fn the_index_and_packages_the_release_tools_make_are_accepted() {
    let m = manager(fixture());
    let entries = m.available().unwrap();
    assert_eq!(entries.len(), 2);
    let dir = tempfile::tempdir().unwrap();
    for backend in [BackendId::Vulkan, BackendId::Cuda] {
        let installed = install(&m, dir.path(), backend).unwrap();
        assert_eq!(installed.backend, backend);
        assert_eq!(installed.version, "0.0.1");
        assert!(installed.compatible);
        assert!(installed.worker.is_file());
    }
}

#[test]
fn an_altered_package_is_refused() {
    let mut files = fixture();
    let name = "oxide-runtime-vulkan-windows-x64-0.0.1.zip";
    let last = files[name].len() - 30;
    files.get_mut(name).unwrap()[last] ^= 1;
    let dir = tempfile::tempdir().unwrap();
    let err = install(&manager(files), dir.path(), BackendId::Vulkan)
        .unwrap_err()
        .to_string();
    assert!(err.contains("hash does not match the index"), "{err}");
}

#[test]
fn an_altered_index_is_refused() {
    let mut files = fixture();
    let index = String::from_utf8(files["runtimes-index.json"].clone())
        .unwrap()
        .replace("\"bytes\"", "\"bytes\": 1, \"was\"");
    files.insert("runtimes-index.json".into(), index.into_bytes());
    let err = manager(files).available().unwrap_err().to_string();
    assert!(err.contains("signature is not valid"), "{err}");
}

#[test]
fn an_altered_or_foreign_signature_is_refused() {
    let mut files = fixture();
    let signature = String::from_utf8(files["runtimes-index.json.minisig"].clone()).unwrap();
    let altered = signature.replace("trusted comment: oxide", "trusted comment: evil");
    files.insert("runtimes-index.json.minisig".into(), altered.into_bytes());
    assert!(manager(files).available().is_err());

    // Signed by the fixture key, not by the key embedded in the app.
    let foreign = RuntimeManager::new(Box::new(Published(fixture())), RUNTIME_PUBLIC_KEY)
        .for_platform("windows-x86_64");
    let err = foreign.available().unwrap_err().to_string();
    assert!(err.contains("signature is not valid"), "{err}");
}

#[test]
fn the_embedded_key_and_index_url_are_usable() {
    // The embedded key decodes, and the index lives on the repository's releases over HTTPS.
    let m = RuntimeManager::new(Box::new(Published(fixture())), RUNTIME_PUBLIC_KEY);
    let err = m.available().unwrap_err().to_string();
    assert!(!err.contains("Invalid runtime signing key"), "{err}");
    assert!(RUNTIME_INDEX_URL.starts_with("https://github.com/cavallinilorenzo/oxide/releases/"));
    assert!(RUNTIME_INDEX_URL.ends_with("/runtimes-index.json"));
}
