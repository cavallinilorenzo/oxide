//! Global Settings: a human-editable `settings.json` in Oxide's home directory.
//! The file is validated on every load; an invalid file leaves the last valid
//! Settings in effect and reports field-level errors alongside them.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use oxide_provider::claude::ClaudeCustomizations;

use crate::{Error, Result};

pub const SETTINGS_FILE: &str = "settings.json";
const RELOAD_DEBOUNCE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
}

pub use oxide_provider::PermissionMode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    /// `None` means the Provider's own default Model.
    pub model: Option<String>,
    /// `None` means the Provider's own default Effort.
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
}

impl Default for ProviderSettings {
    fn default() -> Self {
        Self {
            model: None,
            effort: None,
            permission_mode: PermissionMode::Ask,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Providers {
    pub claude: ProviderSettings,
    pub codex: ProviderSettings,
    pub antigravity: ProviderSettings,
}

impl Default for Providers {
    fn default() -> Self {
        Self {
            claude: ProviderSettings::default(),
            codex: ProviderSettings::default(),
            antigravity: ProviderSettings {
                permission_mode: PermissionMode::AutoEdit,
                ..ProviderSettings::default()
            },
        }
    }
}

/// Keyboard shortcuts as accelerators such as `Mod+Shift+M`: `Mod` is ⌘ on macOS and Ctrl
/// elsewhere, then optional `Alt` and `Shift`, then one key (`N`, `\`, `ArrowUp`, `F5`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub new_thread: String,
    pub open_project: String,
    pub model_picker: String,
    pub pull_requests: String,
    pub issues: String,
    pub terminal: String,
    pub files: String,
    pub diff: String,
    pub previous_thread: String,
    pub next_thread: String,
    pub toggle_tools: String,
    pub toggle_board: String,
    pub open_settings: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        let s = |accelerator: &str| accelerator.to_string();
        Self {
            new_thread: s("Mod+N"),
            open_project: s("Mod+Shift+N"),
            model_picker: s("Mod+Shift+M"),
            pull_requests: s("Mod+Shift+P"),
            issues: s("Mod+Shift+I"),
            terminal: s("Mod+Shift+T"),
            files: s("Mod+Shift+F"),
            diff: s("Mod+Shift+D"),
            previous_thread: s("Mod+ArrowUp"),
            next_thread: s("Mod+ArrowDown"),
            toggle_tools: s("Mod+\\"),
            toggle_board: s("Mod+B"),
            open_settings: s("Mod+,"),
        }
    }
}

impl Shortcuts {
    /// Every shortcut as `(settings key, accelerator)`.
    fn slots(&mut self) -> [(&'static str, &mut String); 13] {
        [
            ("newThread", &mut self.new_thread),
            ("openProject", &mut self.open_project),
            ("modelPicker", &mut self.model_picker),
            ("pullRequests", &mut self.pull_requests),
            ("issues", &mut self.issues),
            ("terminal", &mut self.terminal),
            ("files", &mut self.files),
            ("diff", &mut self.diff),
            ("previousThread", &mut self.previous_thread),
            ("nextThread", &mut self.next_thread),
            ("toggleTools", &mut self.toggle_tools),
            ("toggleBoard", &mut self.toggle_board),
            ("openSettings", &mut self.open_settings),
        ]
    }
}

/// Why `accelerator` is not a usable shortcut, or `None` if it is.
fn accelerator_problem(accelerator: &str) -> Option<String> {
    let mut parts: Vec<&str> = accelerator.split('+').collect();
    // A literal `+` key is written `Mod++`.
    let key = if accelerator.ends_with("++") {
        parts.truncate(parts.len().saturating_sub(2));
        "+"
    } else {
        parts.pop().unwrap_or("")
    };
    let (mut primary, mut alt, mut shift) = (false, false, false);
    for modifier in parts {
        let seen = match modifier {
            "Mod" => &mut primary,
            "Alt" => &mut alt,
            "Shift" => &mut shift,
            other => return Some(format!("unknown modifier `{other}`; use Mod, Alt or Shift")),
        };
        if std::mem::replace(seen, true) {
            return Some(format!("`{modifier}` appears twice"));
        }
    }
    if !primary {
        return Some("a shortcut must include Mod (⌘ on macOS, Ctrl elsewhere)".into());
    }
    let named = matches!(key, "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight")
        || key
            .strip_prefix('F')
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (1..=12).contains(&n));
    let mut chars = key.chars();
    let single = matches!(
        (chars.next(), chars.next()),
        (Some(c), None) if c.is_ascii_graphic() && !c.is_ascii_lowercase()
    );
    (!named && !single).then(|| {
        format!("`{key}` is not a key; use one capital letter, digit or symbol, an arrow or F1-F12")
    })
}

fn shortcuts(obj: Option<Map<String, Value>>, errors: &mut Vec<FieldError>) -> Shortcuts {
    let mut obj = obj.unwrap_or_default();
    let mut shortcuts = Shortcuts::default();
    for (key, slot) in shortcuts.slots() {
        let default = slot.clone();
        *slot = field(&mut obj, "shortcuts", key, default, errors);
    }
    unknown_keys(&obj, "shortcuts", errors);

    let mut taken: Vec<(&str, String)> = vec![];
    for (key, accelerator) in shortcuts.slots() {
        let problem = accelerator_problem(accelerator).or_else(|| {
            taken
                .iter()
                .find(|(_, other)| other.eq_ignore_ascii_case(accelerator))
                .map(|(other, _)| format!("`{accelerator}` is already used by `{other}`"))
        });
        match problem {
            Some(message) => errors.push(FieldError {
                path: join("shortcuts", key),
                message,
            }),
            None => taken.push((key, accelerator.clone())),
        }
    }
    shortcuts
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_provider: Provider,
    pub providers: Providers,
    pub confirm_quit: bool,
    /// Bundle identifier of the editor "Open in editor" uses; empty or not detected means
    /// the first detected editor.
    pub editor: String,
    /// Which of the user's own `CLAUDE.md`, skills, plugins, hooks and MCP servers Claude Code
    /// may load. All off by default so a new Thread starts with a clean context window.
    pub claude_customizations: ClaudeCustomizations,
    /// Keyboard shortcuts, all rebindable in Settings.
    pub shortcuts: Shortcuts,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_provider: Provider::Claude,
            providers: Providers::default(),
            confirm_quit: true,
            editor: String::new(),
            claude_customizations: ClaudeCustomizations::default(),
            shortcuts: Shortcuts::default(),
        }
    }
}

/// One problem in `settings.json`; `path` is dotted, e.g. `providers.claude.model`
/// (empty when the file as a whole is unreadable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldError {
    pub path: String,
    pub message: String,
}

/// The Settings in effect plus any problems found in the file on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsState {
    pub settings: Settings,
    pub errors: Vec<FieldError>,
}

type Subscriber = Box<dyn Fn(&SettingsState) + Send + Sync>;

pub(crate) struct SettingsStore {
    path: PathBuf,
    state: Mutex<SettingsState>,
    subscribers: Mutex<Vec<Subscriber>>,
}

impl SettingsStore {
    /// Loads (creating with defaults if missing) and starts watching the file.
    pub(crate) fn open(home: &Path) -> Result<(Arc<Self>, RecommendedWatcher)> {
        let path = home.join(SETTINGS_FILE);
        if !path.exists() {
            write_file(&path, &Settings::default())?;
        }
        let store = Arc::new(Self {
            path,
            state: Mutex::new(SettingsState {
                settings: Settings::default(),
                errors: vec![],
            }),
            subscribers: Mutex::new(vec![]),
        });
        store.reload()?;

        let weak = Arc::downgrade(&store);
        let pending = Arc::new(AtomicBool::new(false));
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let (Some(store), Ok(event)) = (weak.upgrade(), event) else {
                    return;
                };
                if !event
                    .paths
                    .iter()
                    .any(|p| p.file_name() == store.path.file_name())
                {
                    return;
                }
                // Editors may truncate then write; wait for the burst to settle so
                // a half-written file is never reported as an error.
                if pending.swap(true, Ordering::SeqCst) {
                    return;
                }
                let pending = pending.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(RELOAD_DEBOUNCE);
                    pending.store(false, Ordering::SeqCst);
                    let _ = store.reload();
                });
            })
            .map_err(|e| watch_error(home, e))?;
        // Watch the directory: editors often replace the file via rename.
        watcher
            .watch(home, RecursiveMode::NonRecursive)
            .map_err(|e| watch_error(home, e))?;
        Ok((store, watcher))
    }

    pub(crate) fn get(&self) -> SettingsState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub(crate) fn subscribe(&self, f: Subscriber) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(f);
    }

    pub(crate) fn save(&self, settings: &Settings) -> Result<()> {
        write_file(&self.path, settings)?;
        self.reload()
    }

    /// Re-reads the file; notifies subscribers only if the resulting state changed.
    fn reload(&self) -> Result<()> {
        if !self.path.exists() {
            // Deleted while running: recreate it from the Settings in effect.
            write_file(&self.path, &self.get().settings)?;
        }
        let text = fs::read_to_string(&self.path).map_err(|source| Error::Io {
            path: self.path.clone(),
            source,
        })?;
        let next = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let next = match parse(&text) {
                Ok(settings) => SettingsState {
                    settings,
                    errors: vec![],
                },
                Err(errors) => SettingsState {
                    settings: state.settings.clone(),
                    errors,
                },
            };
            if *state == next {
                return Ok(());
            }
            *state = next.clone();
            next
        };
        for f in self
            .subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            f(&next);
        }
        Ok(())
    }
}

fn watch_error(home: &Path, e: notify::Error) -> Error {
    Error::Io {
        path: home.to_path_buf(),
        source: std::io::Error::other(e),
    }
}

/// Writes via a temp file + rename so a watcher never sees a half-written file.
fn write_file(path: &Path, settings: &Settings) -> Result<()> {
    let io = |source| Error::Io {
        path: path.to_path_buf(),
        source,
    };
    let mut text = serde_json::to_string_pretty(settings).expect("settings serialize");
    text.push('\n');
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(io)?;
    fs::rename(&tmp, path).map_err(io)
}

/// Validates `settings.json` text. Missing keys take their defaults; unknown
/// keys, wrong types and unknown values are reported per field.
fn parse(text: &str) -> std::result::Result<Settings, Vec<FieldError>> {
    let fail = |path: &str, message: String| {
        vec![FieldError {
            path: path.into(),
            message,
        }]
    };
    let root = match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err(fail("", "settings must be a JSON object".into())),
        Err(e) => return Err(fail("", e.to_string())),
    };

    let mut errors = vec![];
    let defaults = Settings::default();
    let mut root = root;
    // Older versions exposed discovery roots as a setting. Ignore it, even if malformed.
    root.remove("scanRoots");
    let settings = Settings {
        default_provider: field(
            &mut root,
            "",
            "defaultProvider",
            defaults.default_provider,
            &mut errors,
        ),
        providers: providers(
            take_object(&mut root, "providers", &mut errors),
            &mut errors,
        ),
        confirm_quit: field(
            &mut root,
            "",
            "confirmQuit",
            defaults.confirm_quit,
            &mut errors,
        ),
        editor: field(&mut root, "", "editor", defaults.editor, &mut errors),
        shortcuts: shortcuts(
            take_object(&mut root, "shortcuts", &mut errors),
            &mut errors,
        ),
        claude_customizations: {
            // Older files held one on/off switch for every category.
            if let Some(Value::Bool(all)) = root.get("claudeCustomizations") {
                let all = *all;
                root.insert(
                    "claudeCustomizations".into(),
                    serde_json::to_value(if all {
                        ClaudeCustomizations::ALL
                    } else {
                        ClaudeCustomizations::default()
                    })
                    .expect("serialize"),
                );
            }
            field(
                &mut root,
                "",
                "claudeCustomizations",
                defaults.claude_customizations,
                &mut errors,
            )
        },
    };
    unknown_keys(&root, "", &mut errors);
    if errors.is_empty() {
        Ok(settings)
    } else {
        Err(errors)
    }
}

fn providers(obj: Option<Map<String, Value>>, errors: &mut Vec<FieldError>) -> Providers {
    let mut obj = obj.unwrap_or_default();
    let mut providers = Providers {
        claude: provider(
            take_object(&mut obj, "claude", errors),
            "providers.claude",
            errors,
        ),
        codex: provider(
            take_object(&mut obj, "codex", errors),
            "providers.codex",
            errors,
        ),
        antigravity: provider(
            take_object(&mut obj, "antigravity", errors),
            "providers.antigravity",
            errors,
        ),
    };
    // Older Settings offered Ask for agy, which cannot answer Approvals.
    if providers.antigravity.permission_mode == PermissionMode::Ask {
        providers.antigravity.permission_mode = PermissionMode::AutoEdit;
    }
    unknown_keys(&obj, "providers", errors);
    providers
}

fn provider(
    obj: Option<Map<String, Value>>,
    at: &str,
    errors: &mut Vec<FieldError>,
) -> ProviderSettings {
    let mut obj = obj.unwrap_or_default();
    let d = ProviderSettings::default();
    let p = ProviderSettings {
        model: field(&mut obj, at, "model", d.model, errors),
        effort: field(&mut obj, at, "effort", d.effort, errors),
        permission_mode: field(&mut obj, at, "permissionMode", d.permission_mode, errors),
    };
    unknown_keys(&obj, at, errors);
    p
}

fn join(at: &str, key: &str) -> String {
    if at.is_empty() {
        key.into()
    } else {
        format!("{at}.{key}")
    }
}

fn field<T: DeserializeOwned>(
    obj: &mut Map<String, Value>,
    at: &str,
    key: &str,
    default: T,
    errors: &mut Vec<FieldError>,
) -> T {
    match obj.remove(key) {
        None => default,
        Some(v) => serde_json::from_value(v).unwrap_or_else(|e| {
            errors.push(FieldError {
                path: join(at, key),
                message: e.to_string(),
            });
            default
        }),
    }
}

fn take_object(
    obj: &mut Map<String, Value>,
    key: &str,
    errors: &mut Vec<FieldError>,
) -> Option<Map<String, Value>> {
    match obj.remove(key)? {
        Value::Object(m) => Some(m),
        _ => {
            errors.push(FieldError {
                path: key.into(),
                message: "expected an object".into(),
            });
            None
        }
    }
}

fn unknown_keys(obj: &Map<String, Value>, at: &str, errors: &mut Vec<FieldError>) {
    for key in obj.keys() {
        errors.push(FieldError {
            path: join(at, key),
            message: "unknown setting".into(),
        });
    }
}
