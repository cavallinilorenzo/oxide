//! Downloadable GPU dictation runtimes (Vulkan, CUDA) installed under `<home>/runtimes`.
//!
//! The official installer ships CPU only. A runtime is a zip with a `manifest.json`, the worker
//! and its DLLs. The index listing the packages is signed with minisign; every package is checked
//! against the index (size + SHA-256) and every file against the package manifest before the
//! package is moved atomically into `<home>/runtimes/<backend>/<version>/`.
use super::{BackendId, err};
use crate::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

/// Worker wire protocol this app speaks. Packages with another value are refused.
pub const PROTOCOL_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "manifest.json";
const MAX_INDEX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIndex {
    pub version: u32,
    pub runtimes: Vec<RuntimeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEntry {
    pub backend: BackendId,
    pub version: String,
    pub protocol_version: u32,
    pub platform: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
    /// Human readable driver / compute-capability requirements.
    #[serde(default)]
    pub requirements: String,
}

/// `manifest.json` inside a package.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub backend: BackendId,
    pub version: String,
    pub protocol_version: u32,
    pub worker: String,
    /// Relative file name -> SHA-256 of every file besides the manifest.
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRuntime {
    pub backend: BackendId,
    pub version: String,
    pub protocol_version: u32,
    pub compatible: bool,
    pub bytes: u64,
    pub worker: PathBuf,
}

/// Network boundary, injectable for offline tests.
pub trait RuntimeSource: Send + Sync {
    /// Index bytes and their detached minisign signature.
    fn index(&self) -> Result<(Vec<u8>, String)>;
    fn open(
        &self,
        entry: &RuntimeEntry,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Box<dyn Read + Send>>;
}

pub fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub fn runtimes_dir(home: &Path) -> PathBuf {
    home.join("runtimes")
}

static ROOT: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Tell worker discovery where runtimes live. Called once by the app with its home directory.
pub fn set_home(home: &Path) {
    *ROOT.write().unwrap() = Some(runtimes_dir(home));
}

pub(super) fn installed_worker(backend: BackendId) -> Option<PathBuf> {
    let root = ROOT.read().unwrap().clone()?;
    find_worker(&root, backend)
}

/// Highest compatible installed version. Never consults `PATH`.
pub fn find_worker(root: &Path, backend: BackendId) -> Option<PathBuf> {
    list(root)
        .into_iter()
        .filter(|r| r.backend == backend && r.compatible)
        .max_by(|a, b| version_key(&a.version).cmp(&version_key(&b.version)))
        .map(|r| r.worker)
}

fn version_key(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse().ok())
        .collect()
}

fn dir_name(backend: BackendId) -> Result<&'static str> {
    match backend {
        BackendId::Vulkan => Ok("vulkan"),
        BackendId::Cuda => Ok("cuda"),
        _ => Err(err("Only Vulkan and CUDA are downloadable runtimes")),
    }
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && !version.starts_with('.')
}

fn dir_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| match e.metadata() {
            Ok(m) if m.is_dir() => dir_size(&e.path()),
            Ok(m) => m.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Installed runtimes whose manifest can be read. Broken folders are ignored.
pub fn list(root: &Path) -> Vec<InstalledRuntime> {
    let mut found = Vec::new();
    for backend in [BackendId::Vulkan, BackendId::Cuda] {
        let Ok(name) = dir_name(backend) else {
            continue;
        };
        let Ok(versions) = fs::read_dir(root.join(name)) else {
            continue;
        };
        for version in versions.flatten() {
            let dir = version.path();
            let Ok(manifest) = read_manifest(&dir) else {
                continue;
            };
            let worker = dir.join(&manifest.worker);
            if manifest.backend != backend
                || dir.file_name().is_none_or(|n| *n != *manifest.version)
                || !worker.is_file()
            {
                continue;
            }
            found.push(InstalledRuntime {
                backend,
                compatible: manifest.protocol_version == PROTOCOL_VERSION,
                protocol_version: manifest.protocol_version,
                version: manifest.version,
                bytes: dir_size(&dir),
                worker,
            });
        }
    }
    found
}

fn read_manifest(dir: &Path) -> Result<PackageManifest> {
    let bytes = fs::read(dir.join(MANIFEST_FILE)).map_err(err)?;
    serde_json::from_slice(&bytes).map_err(err)
}

/// Remove every installed version of a backend. Missing runtimes are not an error.
pub fn remove(root: &Path, backend: BackendId) -> Result<()> {
    let dir = root.join(dir_name(backend)?);
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(format!("Could not remove the runtime: {e}"))),
    }
}

pub struct RuntimeManager {
    source: Box<dyn RuntimeSource>,
    public_key: String,
}

impl RuntimeManager {
    pub fn new(source: Box<dyn RuntimeSource>, public_key: impl Into<String>) -> Self {
        Self {
            source,
            public_key: public_key.into(),
        }
    }

    /// Verified index entries for this platform and protocol.
    pub fn available(&self) -> Result<Vec<RuntimeEntry>> {
        let (bytes, signature) = self.source.index()?;
        if bytes.len() as u64 > MAX_INDEX_BYTES {
            return Err(err("Runtime index is too large"));
        }
        verify_signature(&self.public_key, &bytes, &signature)?;
        let index: RuntimeIndex = serde_json::from_slice(&bytes).map_err(err)?;
        let platform = platform();
        Ok(index
            .runtimes
            .into_iter()
            .filter(|e| {
                e.platform == platform
                    && e.protocol_version == PROTOCOL_VERSION
                    && dir_name(e.backend).is_ok()
                    && valid_version(&e.version)
            })
            .collect())
    }

    /// Download, verify and atomically install the newest package for `backend`.
    /// On any failure nothing is left behind and the previous install is untouched.
    pub fn install(
        &self,
        root: &Path,
        backend: BackendId,
        cancelled: Arc<AtomicBool>,
        progress: impl Fn(u64, u64),
    ) -> Result<InstalledRuntime> {
        let entry = self
            .available()?
            .into_iter()
            .filter(|e| e.backend == backend)
            .max_by(|a, b| version_key(&a.version).cmp(&version_key(&b.version)))
            .ok_or_else(|| err("No compatible runtime is published for this platform"))?;
        let name = dir_name(backend)?;
        fs::create_dir_all(root).map_err(err)?;
        let staging = tempfile::Builder::new()
            .prefix(".staging-")
            .tempdir_in(root)
            .map_err(err)?;

        let archive = staging.path().join("package.zip");
        download(&*self.source, &entry, cancelled, &archive, &progress)?;
        let content = staging.path().join("content");
        extract(&archive, &content)?;
        let manifest = read_manifest(&content)?;
        if manifest.protocol_version != PROTOCOL_VERSION {
            return Err(err(format!(
                "Runtime protocol {} is not supported (expected {PROTOCOL_VERSION})",
                manifest.protocol_version
            )));
        }
        if manifest.backend != backend || manifest.version != entry.version {
            return Err(err("Runtime package does not match the published index"));
        }
        verify_files(&content, &manifest)?;

        let parent = root.join(name);
        fs::create_dir_all(&parent).map_err(err)?;
        let target = parent.join(&entry.version);
        if target.exists() {
            // Reinstall of the same version: swap only after the new tree is verified.
            let old = staging.path().join("old");
            fs::rename(&target, &old).map_err(err)?;
            if let Err(e) = fs::rename(&content, &target) {
                let _ = fs::rename(&old, &target);
                return Err(err(e));
            }
        } else {
            fs::rename(&content, &target).map_err(err)?;
        }
        // Drop superseded versions only once the new one is in place.
        for old in fs::read_dir(&parent).into_iter().flatten().flatten() {
            if old.path() != target {
                let _ = fs::remove_dir_all(old.path());
            }
        }
        list(root)
            .into_iter()
            .find(|r| r.backend == backend && r.version == entry.version)
            .ok_or_else(|| err("Runtime installed but could not be read back"))
    }
}

fn verify_signature(public_key: &str, data: &[u8], signature: &str) -> Result<()> {
    let key = minisign_verify::PublicKey::from_base64(public_key)
        .or_else(|_| minisign_verify::PublicKey::decode(public_key))
        .map_err(|_| err("Invalid runtime signing key"))?;
    let signature = minisign_verify::Signature::decode(signature)
        .map_err(|_| err("Runtime index signature is malformed"))?;
    key.verify(data, &signature, false)
        .map_err(|_| err("Runtime index signature is not valid"))
}

fn download(
    source: &dyn RuntimeSource,
    entry: &RuntimeEntry,
    cancelled: Arc<AtomicBool>,
    path: &Path,
    progress: &impl Fn(u64, u64),
) -> Result<()> {
    let mut input = source.open(entry, cancelled.clone())?;
    let mut file = File::create(path).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut received = 0u64;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(err("Runtime download cancelled"));
        }
        let n = input.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        received += n as u64;
        if received > entry.bytes {
            return Err(err("Runtime package is larger than published"));
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(err)?;
        progress(received, entry.bytes);
    }
    file.flush().map_err(err)?;
    if received != entry.bytes {
        return Err(err("Runtime package is incomplete"));
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(&entry.sha256) {
        return Err(err("Runtime package hash does not match the index"));
    }
    Ok(())
}

fn extract(archive: &Path, into: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(err)?).map_err(err)?;
    fs::create_dir_all(into).map_err(err)?;
    for i in 0..zip.len() {
        let mut item = zip.by_index(i).map_err(err)?;
        let rel = item
            .enclosed_name()
            .ok_or_else(|| err("Runtime package contains an unsafe path"))?;
        // Flat layout only: the worker loads its DLLs from its own folder.
        if rel.components().count() != 1 {
            if item.is_dir() {
                continue;
            }
            return Err(err("Runtime package must be a flat folder"));
        }
        if item.is_dir() {
            continue;
        }
        let mut out = File::create(into.join(&rel)).map_err(err)?;
        std::io::copy(&mut item, &mut out).map_err(err)?;
        #[cfg(unix)]
        if let Some(mode) = item.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(into.join(&rel), fs::Permissions::from_mode(mode & 0o755));
        }
    }
    Ok(())
}

fn verify_files(dir: &Path, manifest: &PackageManifest) -> Result<()> {
    if !manifest.files.contains_key(&manifest.worker) {
        return Err(err("Runtime manifest does not list its worker"));
    }
    for (name, expected) in &manifest.files {
        if Path::new(name).components().count() != 1 || name == MANIFEST_FILE {
            return Err(err("Runtime manifest lists an unsafe file name"));
        }
        let mut file = File::open(dir.join(name))
            .map_err(|_| err(format!("Runtime package is missing {name}")))?;
        let mut hasher = Sha256::new();
        std::io::copy(&mut file, &mut hasher).map_err(err)?;
        if !hex(&hasher.finalize()).eq_ignore_ascii_case(expected) {
            return Err(err(format!("Runtime file {name} failed verification")));
        }
    }
    // Nothing unlisted may ride along.
    for entry in fs::read_dir(dir).map_err(err)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != MANIFEST_FILE && !manifest.files.contains_key(&name) {
            return Err(err(format!("Runtime package has unlisted file {name}")));
        }
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fetches `<index_url>` and `<index_url>.minisig`; package URLs come only from the signed index.
pub struct HttpRuntimeSource {
    pub index_url: String,
}

impl HttpRuntimeSource {
    fn client() -> Result<reqwest::blocking::Client> {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(1800))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(err)
    }
}

impl RuntimeSource for HttpRuntimeSource {
    fn index(&self) -> Result<(Vec<u8>, String)> {
        let client = Self::client()?;
        let get = |url: &str| -> Result<Vec<u8>> {
            let mut body = Vec::new();
            client
                .get(url)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(err)?
                .take(MAX_INDEX_BYTES + 1)
                .read_to_end(&mut body)
                .map_err(err)?;
            Ok(body)
        };
        let index = get(&self.index_url)?;
        let signature = get(&format!("{}.minisig", self.index_url))?;
        Ok((index, String::from_utf8(signature).map_err(err)?))
    }

    fn open(
        &self,
        entry: &RuntimeEntry,
        _cancelled: Arc<AtomicBool>,
    ) -> Result<Box<dyn Read + Send>> {
        if !entry.url.starts_with("https://") {
            return Err(err("Runtime packages must be downloaded over HTTPS"));
        }
        let response = Self::client()?
            .get(&entry.url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(err)?;
        Ok(Box::new(response))
    }
}
