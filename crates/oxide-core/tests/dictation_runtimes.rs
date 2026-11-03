use oxide_core::dictation::{
    BackendId,
    runtimes::{self, PROTOCOL_VERSION, RuntimeEntry, RuntimeIndex, RuntimeManager, RuntimeSource},
};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Read, Write},
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

struct Keys {
    public: String,
    secret: minisign::SecretKey,
}

fn keys() -> Keys {
    let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    Keys {
        public: pair.pk.to_base64(),
        secret: pair.sk,
    }
}

fn sign(keys: &Keys, data: &[u8]) -> String {
    minisign::sign(None, &keys.secret, Cursor::new(data), None, None)
        .unwrap()
        .to_string()
}

fn package(
    backend: &str,
    version: &str,
    protocol: u32,
    tamper: bool,
    extra: Option<&str>,
) -> Vec<u8> {
    let worker = b"worker-binary".to_vec();
    let dll = b"dll".to_vec();
    let manifest = serde_json::json!({
        "backend": backend, "version": version, "protocolVersion": protocol,
        "worker": "oxide-worker",
        "files": {"oxide-worker": sha(&worker), "cudart.dll": sha(if tamper { b"other" } else { &dll })},
    });
    let mut buf = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut buf);
    let opts = zip::write::SimpleFileOptions::default();
    for (name, body) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("oxide-worker", worker),
        ("cudart.dll", dll),
    ] {
        zip.start_file(name, opts).unwrap();
        zip.write_all(&body).unwrap();
    }
    if let Some(extra) = extra {
        zip.start_file(extra, opts).unwrap();
        zip.write_all(b"x").unwrap();
    }
    zip.finish().unwrap();
    buf.into_inner()
}

struct Fake {
    index: Vec<u8>,
    signature: String,
    package: Vec<u8>,
}

impl RuntimeSource for Fake {
    fn index(&self) -> oxide_core::Result<(Vec<u8>, String)> {
        Ok((self.index.clone(), self.signature.clone()))
    }
    fn open(
        &self,
        _: &RuntimeEntry,
        _: Arc<AtomicBool>,
    ) -> oxide_core::Result<Box<dyn Read + Send>> {
        Ok(Box::new(Cursor::new(self.package.clone())))
    }
}

fn setup(
    pkg: Vec<u8>,
    entry_protocol: u32,
    sha_override: Option<String>,
) -> (RuntimeManager, Keys) {
    let keys = keys();
    let index = serde_json::to_vec(&RuntimeIndex {
        version: 1,
        runtimes: vec![RuntimeEntry {
            backend: BackendId::Vulkan,
            version: "1.0.0".into(),
            protocol_version: entry_protocol,
            platform: runtimes::platform(),
            url: "https://example.invalid/vulkan.zip".into(),
            bytes: pkg.len() as u64,
            sha256: sha_override.unwrap_or_else(|| sha(&pkg)),
            requirements: String::new(),
        }],
    })
    .unwrap();
    let signature = sign(&keys, &index);
    let manager = RuntimeManager::new(
        Box::new(Fake {
            index,
            signature,
            package: pkg,
        }),
        keys.public.clone(),
    );
    (manager, keys)
}

fn install(m: &RuntimeManager, root: &Path) -> oxide_core::Result<runtimes::InstalledRuntime> {
    m.install(root, BackendId::Vulkan, Default::default(), |_, _| {})
}

fn leftovers(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn installs_verified_package_and_finds_worker() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, None),
        PROTOCOL_VERSION,
        None,
    );
    let installed = install(&m, dir.path()).unwrap();
    assert!(installed.compatible && installed.worker.is_file());
    assert_eq!(
        runtimes::find_worker(dir.path(), BackendId::Vulkan),
        Some(installed.worker)
    );
    assert_eq!(runtimes::find_worker(dir.path(), BackendId::Cuda), None);
    assert_eq!(leftovers(dir.path()), ["vulkan"]);
}

#[test]
fn rejects_wrong_package_hash_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, None),
        PROTOCOL_VERSION,
        Some("00".repeat(32)),
    );
    let e = install(&m, dir.path()).unwrap_err().to_string();
    assert!(e.contains("hash"), "{e}");
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn rejects_tampered_file() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, true, None),
        PROTOCOL_VERSION,
        None,
    );
    assert!(
        install(&m, dir.path())
            .unwrap_err()
            .to_string()
            .contains("verification")
    );
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn rejects_unlisted_and_nested_files() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, Some("evil.dll")),
        PROTOCOL_VERSION,
        None,
    );
    assert!(
        install(&m, dir.path())
            .unwrap_err()
            .to_string()
            .contains("unlisted")
    );
    let (m, _) = setup(
        package(
            "vulkan",
            "1.0.0",
            PROTOCOL_VERSION,
            false,
            Some("../evil.dll"),
        ),
        PROTOCOL_VERSION,
        None,
    );
    assert!(install(&m, dir.path()).is_err());
    assert!(leftovers(dir.path()).is_empty());
}

#[test]
fn rejects_incompatible_protocol_in_package_and_index() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", 99, false, None),
        PROTOCOL_VERSION,
        None,
    );
    assert!(
        install(&m, dir.path())
            .unwrap_err()
            .to_string()
            .contains("protocol")
    );
    let (m, _) = setup(package("vulkan", "1.0.0", 99, false, None), 99, None);
    assert!(m.available().unwrap().is_empty());
    assert!(install(&m, dir.path()).is_err());
}

#[test]
fn rejects_bad_index_signature() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, None),
        PROTOCOL_VERSION,
        None,
    );
    let other = keys();
    let forged = RuntimeManager::new(
        Box::new(Fake {
            index: m.available().map(|_| b"{}".to_vec()).unwrap(),
            signature: sign(&other, b"{}"),
            package: vec![],
        }),
        keys().public,
    );
    assert!(
        forged
            .available()
            .unwrap_err()
            .to_string()
            .contains("signature")
    );
    assert!(install(&forged, dir.path()).is_err());
}

#[test]
fn incompatible_installed_runtime_is_listed_but_not_used_and_removal_works() {
    let dir = tempfile::tempdir().unwrap();
    let old = dir.path().join("cuda/0.9.0");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("oxide-worker"), b"w").unwrap();
    std::fs::write(old.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
        "backend": "cuda", "version": "0.9.0", "protocolVersion": 0, "worker": "oxide-worker", "files": {}
    })).unwrap()).unwrap();
    let listed = runtimes::list(dir.path());
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].compatible);
    assert_eq!(runtimes::find_worker(dir.path(), BackendId::Cuda), None);
    runtimes::remove(dir.path(), BackendId::Cuda).unwrap();
    assert!(runtimes::list(dir.path()).is_empty());
    runtimes::remove(dir.path(), BackendId::Cuda).unwrap();
}

#[test]
fn reinstall_replaces_existing_version() {
    let dir = tempfile::tempdir().unwrap();
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, None),
        PROTOCOL_VERSION,
        None,
    );
    install(&m, dir.path()).unwrap();
    install(&m, dir.path()).unwrap();
    assert_eq!(runtimes::list(dir.path()).len(), 1);
}

#[test]
fn worker_path_picks_up_a_runtime_installed_after_startup() {
    let dir = tempfile::tempdir().unwrap();
    unsafe { std::env::remove_var("OXIDE_VULKAN_WORKER") };
    runtimes::set_home(dir.path());
    let before = oxide_core::dictation::vulkan::worker_path();
    assert!(!before.starts_with(dir.path()));
    let (m, _) = setup(
        package("vulkan", "1.0.0", PROTOCOL_VERSION, false, None),
        PROTOCOL_VERSION,
        None,
    );
    let installed = install(&m, &runtimes::runtimes_dir(dir.path())).unwrap();
    assert_eq!(
        oxide_core::dictation::vulkan::worker_path(),
        installed.worker
    );
}
