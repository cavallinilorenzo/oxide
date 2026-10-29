//! Attachments: files the user puts inside a prompt.
//!
//! Each one lives at `<home>/attachments/<id>/<original file name>` until its Thread is deleted
//! (or the prompt is abandoned). Nothing but the id is needed to find it again, so the store
//! keeps no registry of its own.

use crate::error::{Error, Result};
use oxide_provider::{Attachment, AttachmentKind, PromptSegment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

/// The largest file one Attachment can hold.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
/// The most Attachments one prompt can carry.
pub const MAX_ATTACHMENTS_PER_PROMPT: usize = 10;
/// Stored Attachments no Turn references are removed after this long.
const ABANDONED_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// How much of a file is read to tell text from binary.
const SNIFF_BYTES: usize = 8 * 1024;

static ATTACHMENT_SEQ: AtomicU32 = AtomicU32::new(0);
static PASTE_SEQ: AtomicU32 = AtomicU32::new(0);

/// Why a file could not become an Attachment, in words the user can act on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AttachmentError {
    #[error("{name} is too large ({size}). Attachments can be up to 25 MB.")]
    TooLarge { name: String, size: String },
    #[error("{name} is a folder. Attach files instead.")]
    IsDirectory { name: String },
    #[error("{name} can't be read: {reason}")]
    Unreadable { name: String, reason: String },
    #[error("A prompt can carry at most {MAX_ATTACHMENTS_PER_PROMPT} attachments.")]
    TooMany,
    #[error("That attachment is no longer available.")]
    Missing,
    #[error("Attachments can't be sent with /{command}.")]
    WithOxideCommand { command: String },
}

/// A prompt as the composer sends it: text, or a reference to a stored Attachment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PromptInput {
    Text { text: String },
    Attachment { id: String },
}

pub struct AttachmentStore {
    dir: PathBuf,
}

impl AttachmentStore {
    /// Preview only a stored image, addressed by id; never accept a frontend file path.
    pub fn preview(&self, id: &str) -> Result<Option<String>> {
        use base64::Engine;
        let attachment = self.describe(id)?;
        if attachment.kind != AttachmentKind::Image {
            return Ok(None);
        }
        let mut bytes = Vec::new();
        let unreadable = |error: std::io::Error| AttachmentError::Unreadable {
            name: attachment.name.clone(),
            reason: reason_of(&error),
        };
        fs::File::open(&attachment.path)
            .map_err(unreadable)?
            .take(MAX_ATTACHMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(unreadable)?;
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(AttachmentError::TooLarge {
                name: attachment.name,
                size: human_size(bytes.len() as u64),
            }
            .into());
        }
        Ok(Some(format!(
            "data:{};base64,{}",
            attachment.media_type,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }

    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Copies the file at `source` into the store. The bytes never leave the backend.
    pub fn attach_path(&self, source: &Path) -> Result<Attachment> {
        let name = file_name_of(source);
        let unreadable = |e: std::io::Error| AttachmentError::Unreadable {
            name: name.clone(),
            reason: reason_of(&e),
        };
        let metadata = fs::metadata(source).map_err(unreadable)?;
        if metadata.is_dir() {
            return Err(AttachmentError::IsDirectory { name }.into());
        }
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(AttachmentError::TooLarge {
                size: human_size(metadata.len()),
                name,
            }
            .into());
        }
        let (id, folder, path) = self.new_slot(&name)?;
        if let Err(e) = fs::copy(source, &path) {
            let _ = fs::remove_dir_all(&folder);
            return Err(unreadable(e).into());
        }
        self.describe(&id).inspect_err(|_| {
            let _ = fs::remove_dir_all(&folder);
        })
    }

    /// Stores pasted bytes. A pasted image without a name is called `pasted-image-N.png`.
    pub fn attach_bytes(&self, name: Option<&str>, bytes: &[u8]) -> Result<Attachment> {
        let name = match name.map(sanitize_name).filter(|n| !n.is_empty()) {
            Some(name) => name,
            None => {
                let ext = sniff_image_extension(bytes).unwrap_or("bin");
                let n = PASTE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
                format!("pasted-image-{n}.{ext}")
            }
        };
        if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(AttachmentError::TooLarge {
                size: human_size(bytes.len() as u64),
                name,
            }
            .into());
        }
        let (id, folder, path) = self.new_slot(&name)?;
        if let Err(e) = fs::write(&path, bytes) {
            let _ = fs::remove_dir_all(&folder);
            return Err(AttachmentError::Unreadable {
                name,
                reason: reason_of(&e),
            }
            .into());
        }
        self.describe(&id)
    }

    /// The stored Attachment with this id.
    pub fn describe(&self, id: &str) -> Result<Attachment> {
        let folder = self.folder_of(id)?;
        let missing = || Error::from(AttachmentError::Missing);
        let entry = fs::read_dir(&folder)
            .map_err(|_| missing())?
            .filter_map(|e| e.ok())
            .find(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .ok_or_else(missing)?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let size_bytes = entry.metadata().map_err(|_| missing())?.len();
        let sample = read_sample(&path).map_err(|e| AttachmentError::Unreadable {
            name: name.clone(),
            reason: reason_of(&e),
        })?;
        let (kind, media_type) = classify(&name, &sample);
        Ok(Attachment {
            id: id.to_string(),
            name,
            kind,
            media_type,
            size_bytes,
            path,
        })
    }

    /// Resolves the composer's prompt into segments, refusing it whole if any Attachment is
    /// missing or there are too many.
    pub fn resolve(&self, input: &[PromptInput]) -> Result<Vec<PromptSegment>> {
        let count = input
            .iter()
            .filter(|i| matches!(i, PromptInput::Attachment { .. }))
            .count();
        if count > MAX_ATTACHMENTS_PER_PROMPT {
            return Err(AttachmentError::TooMany.into());
        }
        input
            .iter()
            .map(|part| match part {
                PromptInput::Text { text } => Ok(PromptSegment::text(text.clone())),
                PromptInput::Attachment { id } => self.describe(id).map(PromptSegment::Attachment),
            })
            .collect()
    }

    /// Whether `path` resolves (symlinks and `..` included) to a file inside the store.
    pub fn contains(&self, path: &Path) -> bool {
        match (path.canonicalize(), self.dir.canonicalize()) {
            (Ok(path), Ok(dir)) => path.starts_with(dir),
            _ => false,
        }
    }

    /// Deletes an Attachment's files. Does nothing for an id that isn't stored.
    pub fn remove(&self, id: &str) {
        if let Ok(folder) = self.folder_of(id) {
            let _ = fs::remove_dir_all(folder);
        }
    }

    /// Deletes the folder holding `path`, when it is a stored Attachment.
    pub fn remove_stored(&self, path: &Path) {
        if !self.contains(path) {
            return;
        }
        match path.parent() {
            Some(folder) if folder != self.dir => {
                let _ = fs::remove_dir_all(folder);
            }
            // Attachments stored before ids had folders were bare files.
            _ => {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// Deletes stored Attachments older than a day that `is_referenced` doesn't claim.
    pub fn remove_abandoned(&self, is_referenced: impl Fn(&str) -> bool) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.filter_map(|e| e.ok()) {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age > ABANDONED_AFTER);
            if old && !is_referenced(&id) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    fn new_slot(&self, name: &str) -> Result<(String, PathBuf, PathBuf)> {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let id = format!(
            "{nanos:x}-{}",
            ATTACHMENT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let folder = self.dir.join(&id);
        fs::create_dir_all(&folder).map_err(|source| Error::Io {
            path: folder.clone(),
            source,
        })?;
        let clean = sanitize_name(name);
        let path = folder.join(if clean.is_empty() {
            "attachment"
        } else {
            &clean
        });
        Ok((id, folder, path))
    }

    /// The folder of an id; refuses anything that isn't a plain id.
    fn folder_of(&self, id: &str) -> Result<PathBuf> {
        let plain = !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if plain {
            Ok(self.dir.join(id))
        } else {
            Err(AttachmentError::Missing.into())
        }
    }
}

/// The id of an Attachment folder inside the store, if `path` is stored in one.
pub fn id_of_path(store_dir: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(store_dir).ok()?;
    let mut parts = relative.components();
    let id = parts.next()?.as_os_str().to_str()?;
    parts.next()?;
    Some(id.to_string())
}

/// An Attachment for a file stored before Attachments had ids and metadata.
pub fn legacy_attachment(path: &str) -> Attachment {
    let path = PathBuf::from(path);
    let name = file_name_of(&path);
    let (kind, media_type) = classify(&name, &[]);
    Attachment {
        id: name.clone(),
        size_bytes: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        name,
        kind,
        media_type,
        path,
    }
}

/// A Turn's segments as stored: the JSON column when the Turn has one, else its text followed by
/// the Attachments of the older path-only list.
pub fn turn_segments(prompt: &str, segments: Option<&str>, legacy: &str) -> Vec<PromptSegment> {
    if let Some(parsed) = segments.and_then(|json| serde_json::from_str(json).ok()) {
        return parsed;
    }
    let paths: Vec<String> = serde_json::from_str(legacy).unwrap_or_default();
    let text = (!prompt.is_empty()).then(|| PromptSegment::text(prompt));
    text.into_iter()
        .chain(
            paths
                .iter()
                .map(|path| PromptSegment::Attachment(legacy_attachment(path))),
        )
        .collect()
}

/// Every stored file a Turn's columns refer to.
pub fn stored_paths(segments: Option<&str>, legacy: &str) -> Vec<PathBuf> {
    let parsed: Vec<PromptSegment> = segments
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    let legacy: Vec<String> = serde_json::from_str(legacy).unwrap_or_default();
    parsed
        .into_iter()
        .filter_map(|segment| match segment {
            PromptSegment::Attachment(a) => Some(a.path),
            PromptSegment::Text { .. } => None,
        })
        .chain(legacy.into_iter().map(PathBuf::from))
        .collect()
}

/// The prompt text with each Attachment as `[name]`.
pub fn render(segments: &[PromptSegment]) -> String {
    oxide_provider::render_prompt(segments)
}

/// Kind and media type from the extension, confirmed by the first bytes of the file.
pub fn classify(name: &str, sample: &[u8]) -> (AttachmentKind, String) {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let by_extension = match ext.as_str() {
        "png" => Some((AttachmentKind::Image, "image/png")),
        "jpg" | "jpeg" => Some((AttachmentKind::Image, "image/jpeg")),
        "gif" => Some((AttachmentKind::Image, "image/gif")),
        "webp" => Some((AttachmentKind::Image, "image/webp")),
        "bmp" => Some((AttachmentKind::Image, "image/bmp")),
        "pdf" => Some((AttachmentKind::Pdf, "application/pdf")),
        _ => None,
    };
    if let Some((kind, media_type)) = by_extension {
        // An empty sample means the content wasn't read (legacy records).
        let confirmed = sample.is_empty()
            || match kind {
                AttachmentKind::Pdf => sample.starts_with(b"%PDF"),
                _ => {
                    sniff_image_extension(sample).is_some()
                        || ext == "bmp" && sample.starts_with(b"BM")
                }
            };
        if confirmed {
            return (kind, media_type.to_string());
        }
    }
    if !sample.is_empty() && looks_like_text(sample) {
        return (AttachmentKind::Text, text_media_type(&ext).to_string());
    }
    (
        AttachmentKind::Other,
        "application/octet-stream".to_string(),
    )
}

fn text_media_type(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ => "text/plain",
    }
}

fn sniff_image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Valid UTF-8 without NUL bytes. The sample may end in the middle of a character.
fn looks_like_text(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return false;
    }
    match std::str::from_utf8(sample) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 > sample.len(),
    }
}

fn read_sample(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut sample = Vec::with_capacity(SNIFF_BYTES);
    fs::File::open(path)?
        .take(SNIFF_BYTES as u64)
        .read_to_end(&mut sample)?;
    Ok(sample)
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// A name that is safe as one path component on every platform, keeping the extension.
fn sanitize_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches([' ', '.']).to_string();
    if cleaned.len() <= 200 {
        return cleaned;
    }
    let ext = Path::new(&cleaned)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let stem: String = cleaned.chars().take(150).collect();
    format!("{stem}{ext}")
}

fn reason_of(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        std::io::ErrorKind::NotFound => "the file no longer exists".into(),
        _ => error.to_string(),
    }
}

fn human_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    format!("{:.1} MB", bytes as f64 / MB)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_follows_the_extension_and_is_confirmed_by_content() {
        assert_eq!(
            classify("a.png", b"\x89PNG\r\n\x1a\nrest").0,
            AttachmentKind::Image
        );
        assert_eq!(classify("spec.PDF", b"%PDF-1.7").0, AttachmentKind::Pdf);
        // An image that isn't one falls through to what its content is.
        assert_eq!(classify("fake.png", b"just words").0, AttachmentKind::Text);
        assert_eq!(
            classify("fake.pdf", b"\x00\x01\x02").0,
            AttachmentKind::Other
        );
        assert_eq!(classify("main.rs", b"fn main() {}").0, AttachmentKind::Text);
        assert_eq!(
            classify("data.xlsx", b"PK\x03\x04\x00").0,
            AttachmentKind::Other
        );
    }

    #[test]
    fn names_lose_path_parts_and_reserved_characters() {
        assert_eq!(sanitize_name("../../etc/pass:wd.txt"), "pass_wd.txt");
        assert_eq!(sanitize_name("C:\\Users\\me\\shot.png"), "shot.png");
        assert_eq!(sanitize_name(".."), "");
    }
}
