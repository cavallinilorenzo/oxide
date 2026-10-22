//! Editors Oxide can open a checkout in: a fixed list of known macOS editors,
//! identified by bundle identifier. Which are installed is the shell's to say.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub name: String,
    pub bundle_id: String,
}

/// Name and bundle identifier of every editor Oxide knows, in the order they are offered.
const KNOWN: &[(&str, &str)] = &[
    ("Visual Studio Code", "com.microsoft.VSCode"),
    ("VS Code Insiders", "com.microsoft.VSCodeInsiders"),
    ("VSCodium", "com.vscodium"),
    ("Cursor", "com.todesktop.230313mzl4w4u92"),
    ("Windsurf", "com.exafunction.windsurf"),
    ("Zed", "dev.zed.Zed"),
    ("Zed Preview", "dev.zed.Zed-Preview"),
    ("Sublime Text", "com.sublimetext.4"),
    ("Xcode", "com.apple.dt.Xcode"),
    ("IntelliJ IDEA", "com.jetbrains.intellij"),
    ("WebStorm", "com.jetbrains.WebStorm"),
    ("PyCharm", "com.jetbrains.pycharm"),
    ("RustRover", "com.jetbrains.rustrover"),
    ("Nova", "com.panic.Nova"),
    ("BBEdit", "com.barebones.bbedit"),
    ("TextMate", "com.macromates.TextMate"),
];

/// The known editors `is_installed` accepts.
pub fn detect(is_installed: impl Fn(&str) -> bool) -> Vec<Editor> {
    KNOWN
        .iter()
        .filter(|(_, bundle_id)| is_installed(bundle_id))
        .map(|(name, bundle_id)| Editor {
            name: (*name).into(),
            bundle_id: (*bundle_id).into(),
        })
        .collect()
}

/// The editor to open with: the configured one if detected, else the first detected.
pub fn choose<'a>(detected: &'a [Editor], configured: &str) -> Option<&'a Editor> {
    detected
        .iter()
        .find(|e| e.bundle_id == configured)
        .or_else(|| detected.first())
}
