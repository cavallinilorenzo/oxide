//! Editors Oxide can open a checkout in: a fixed list of known editors,
//! identified by bundle identifier. Which are installed is the shell's to say on macOS,
//! or detected via PATH and Registry on Windows.

use serde::Serialize;
use std::path::{Path, PathBuf};

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

#[derive(Clone, Copy)]
#[allow(dead_code)]
struct WindowsEditorSpec {
    bundle_id: &'static str,
    commands: &'static [&'static str],
    app_paths: &'static [&'static str],
    uninstall_names: &'static [&'static str],
    env_fallbacks: &'static [(&'static str, &'static str)],
}

#[allow(dead_code)]
const WINDOWS_SPECS: &[WindowsEditorSpec] = &[
    WindowsEditorSpec {
        bundle_id: "com.microsoft.VSCode",
        commands: &["code.cmd", "code.exe", "code"],
        app_paths: &["code.exe"],
        uninstall_names: &["Microsoft Visual Studio Code", "Visual Studio Code"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
            ("LOCALAPPDATA", "Programs/Microsoft VS Code/bin/code.cmd"),
            ("ProgramFiles", "Microsoft VS Code/Code.exe"),
            ("ProgramFiles", "Microsoft VS Code/bin/code.cmd"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "com.microsoft.VSCodeInsiders",
        commands: &["code-insiders.cmd", "code-insiders.exe", "code-insiders"],
        app_paths: &["code-insiders.exe"],
        uninstall_names: &["Visual Studio Code Insiders"],
        env_fallbacks: &[
            (
                "LOCALAPPDATA",
                "Programs/Microsoft VS Code Insiders/Code - Insiders.exe",
            ),
            (
                "ProgramFiles",
                "Microsoft VS Code Insiders/Code - Insiders.exe",
            ),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "com.vscodium",
        commands: &["codium.cmd", "codium.exe", "codium"],
        app_paths: &["codium.exe"],
        uninstall_names: &["VSCodium"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/VSCodium/VSCodium.exe"),
            ("ProgramFiles", "VSCodium/VSCodium.exe"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "com.todesktop.230313mzl4w4u92",
        commands: &["cursor.cmd", "cursor.exe", "cursor"],
        app_paths: &["cursor.exe", "Cursor.exe"],
        uninstall_names: &["Cursor"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/cursor/Cursor.exe"),
            ("LOCALAPPDATA", "cursor/Cursor.exe"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "com.exafunction.windsurf",
        commands: &["windsurf.cmd", "windsurf.exe", "windsurf"],
        app_paths: &["windsurf.exe", "Windsurf.exe"],
        uninstall_names: &["Windsurf"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/Windsurf/Windsurf.exe"),
            ("LOCALAPPDATA", "Programs/Windsurf/bin/windsurf.cmd"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "dev.zed.Zed",
        commands: &["zed.exe", "zed.cmd", "zed"],
        app_paths: &["zed.exe", "Zed.exe"],
        uninstall_names: &["Zed"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/Zed/Zed.exe"),
            ("LOCALAPPDATA", "Programs/Zed/bin/Zed.exe"),
            ("LOCALAPPDATA", "Zed/Zed.exe"),
            ("ProgramFiles", "Zed/Zed.exe"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "dev.zed.Zed-Preview",
        commands: &["zed-preview.exe", "zed-preview.cmd", "zed-preview"],
        app_paths: &["zed-preview.exe"],
        uninstall_names: &["Zed Preview"],
        env_fallbacks: &[
            ("LOCALAPPDATA", "Programs/Zed Preview/Zed.exe"),
            ("LOCALAPPDATA", "Zed Preview/Zed.exe"),
        ],
    },
    WindowsEditorSpec {
        bundle_id: "com.sublimetext.4",
        commands: &["subl.exe", "sublime_text.exe", "subl"],
        app_paths: &["sublime_text.exe"],
        uninstall_names: &["Sublime Text"],
        env_fallbacks: &[
            ("ProgramFiles", "Sublime Text/sublime_text.exe"),
            ("ProgramFiles", "Sublime Text 3/sublime_text.exe"),
        ],
    },
];

#[allow(dead_code)]
fn spec_for_bundle(bundle_id: &str) -> Option<&'static WindowsEditorSpec> {
    WINDOWS_SPECS.iter().find(|s| s.bundle_id == bundle_id)
}

/// Checks whether an editor is installed on Windows, looking at PATH and Registry.
#[allow(dead_code)]
pub fn is_installed_windows(bundle_id: &str) -> bool {
    find_windows_editor(bundle_id).is_some()
}

/// Finds the executable for an editor on Windows by checking PATH and Registry.
#[allow(dead_code)]
pub fn find_windows_editor(bundle_id: &str) -> Option<PathBuf> {
    find_windows_editor_with(bundle_id, std::env::var_os("PATH").as_deref())
}

/// Finds the executable for an editor using an explicit PATH environment (useful for tests).
#[allow(dead_code)]
pub fn find_windows_editor_with(
    bundle_id: &str,
    path_env: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let spec = spec_for_bundle(bundle_id)?;

    // 1. Check PATH
    if let Some(path) = path_env {
        for cmd in spec.commands {
            if let Some(found) =
                oxide_provider::command::find_in(path, std::ffi::OsStr::new(cmd), None)
                    .filter(|f| f.is_file())
            {
                return Some(found);
            }
        }
    }

    // 2. Check Registry App Paths
    #[cfg(windows)]
    for app_path in spec.app_paths {
        if let Some(found) = query_app_path(app_path).filter(|f| f.is_file()) {
            return Some(found);
        }
    }

    // 3. Check Registry Uninstall
    #[cfg(windows)]
    for name in spec.uninstall_names {
        if let Some(found) = query_uninstall_display_icon_or_location(name).filter(|f| f.is_file())
        {
            return Some(found);
        }
    }

    // 4. Check well-known fallback directories
    for (env_var, rel_path) in spec.env_fallbacks {
        if let Some(base) = std::env::var_os(env_var) {
            let candidate = PathBuf::from(base).join(rel_path);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

/// Opens a path in the specified editor on Windows.
#[allow(dead_code)]
pub fn open_windows(bundle_id: &str, path: &Path) -> bool {
    if let Some(exe) = find_windows_editor(bundle_id) {
        std::process::Command::new(exe).arg(path).spawn().is_ok()
    } else {
        false
    }
}

/// Detects all installed editors on Windows without needing a custom callback.
#[allow(dead_code)]
pub fn detect_windows() -> Vec<Editor> {
    detect(is_installed_windows)
}

#[cfg(windows)]
fn query_app_path(key_name: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let subkey = format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{key_name}");
    if let Some(val) = read_reg_string(HKEY_CURRENT_USER, &subkey, None) {
        let path = PathBuf::from(val);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(val) = read_reg_string(HKEY_LOCAL_MACHINE, &subkey, None) {
        let path = PathBuf::from(val);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn query_uninstall_display_icon_or_location(editor_name: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for prefix in [
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        ] {
            if let Some(path) = scan_uninstall_subkeys(root, prefix, editor_name) {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(windows)]
fn scan_uninstall_subkeys(
    root: windows_sys::Win32::System::Registry::HKEY,
    prefix: &str,
    target_name: &str,
) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, KEY_READ, RegCloseKey, RegEnumKeyExW, RegOpenKeyExW,
    };

    let wide_prefix: Vec<u16> = std::ffi::OsStr::new(prefix)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut parent_key: HKEY = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(root, wide_prefix.as_ptr(), 0, KEY_READ, &mut parent_key) != ERROR_SUCCESS
        {
            return None;
        }

        let mut index = 0u32;
        let mut subkey_name = vec![0u16; 256];
        loop {
            let mut name_len = subkey_name.len() as u32;
            let status = RegEnumKeyExW(
                parent_key,
                index,
                subkey_name.as_mut_ptr(),
                &mut name_len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if status != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let subkey_str = String::from_utf16_lossy(&subkey_name[..name_len as usize]);
            let full_subkey = format!("{prefix}\\{subkey_str}");

            if let Some(display_name) = read_reg_string(root, &full_subkey, Some("DisplayName")) {
                if !display_name
                    .to_lowercase()
                    .contains(&target_name.to_lowercase())
                {
                    continue;
                }
                if let Some(icon) = read_reg_string(root, &full_subkey, Some("DisplayIcon")) {
                    let candidate = icon
                        .split(',')
                        .next()
                        .unwrap_or(&icon)
                        .trim()
                        .trim_matches('"');
                    let p = PathBuf::from(candidate);
                    if p.is_file() {
                        RegCloseKey(parent_key);
                        return Some(p);
                    }
                }
                if let Some(loc) = read_reg_string(root, &full_subkey, Some("InstallLocation")) {
                    let loc_path = PathBuf::from(loc.trim().trim_matches('"'));
                    if loc_path.is_dir() {
                        for file in [
                            "Code.exe",
                            "Cursor.exe",
                            "Windsurf.exe",
                            "Zed.exe",
                            "sublime_text.exe",
                        ] {
                            let exe = loc_path.join(file);
                            if exe.is_file() {
                                RegCloseKey(parent_key);
                                return Some(exe);
                            }
                        }
                    }
                }
            }
        }
        RegCloseKey(parent_key);
    }
    None
}

#[cfg(windows)]
fn read_reg_string(
    hkey_root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
    value_name: Option<&str>,
) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };

    let wide_subkey: Vec<u16> = std::ffi::OsStr::new(subkey)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let wide_name: Option<Vec<u16>> = value_name.map(|n| {
        std::ffi::OsStr::new(n)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    });

    let mut key: HKEY = std::ptr::null_mut();
    unsafe {
        if RegOpenKeyExW(hkey_root, wide_subkey.as_ptr(), 0, KEY_READ, &mut key) != ERROR_SUCCESS {
            return None;
        }
        let name_ptr = wide_name.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
        let mut data_type = 0u32;
        let mut data_len = 0u32;

        let status = RegQueryValueExW(
            key,
            name_ptr,
            std::ptr::null_mut(),
            &mut data_type,
            std::ptr::null_mut(),
            &mut data_len,
        );
        if (status != ERROR_SUCCESS && status != ERROR_MORE_DATA) || data_len == 0 {
            RegCloseKey(key);
            return None;
        }

        let mut buffer: Vec<u8> = vec![0u8; data_len as usize];
        let status = RegQueryValueExW(
            key,
            name_ptr,
            std::ptr::null_mut(),
            &mut data_type,
            buffer.as_mut_ptr(),
            &mut data_len,
        );
        RegCloseKey(key);

        if status != ERROR_SUCCESS {
            return None;
        }

        // REG_SZ = 1, REG_EXPAND_SZ = 2
        if data_type == 1 || data_type == 2 {
            let u16_slice: &[u16] = std::slice::from_raw_parts(
                buffer.as_ptr() as *const u16,
                (data_len as usize) / std::mem::size_of::<u16>(),
            );
            let s = String::from_utf16_lossy(u16_slice);
            let trimmed = s.trim_matches(['\0', '"', ' ']);
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_editor_in_path() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_code = tmp.path().join("code.cmd");
        std::fs::write(&fake_code, "@echo off\n").unwrap();

        let found = find_windows_editor_with("com.microsoft.VSCode", Some(tmp.path().as_os_str()));
        assert!(found.is_some());
        assert_eq!(found.unwrap().file_name().unwrap(), "code.cmd");
    }

    #[test]
    fn detects_cursor_and_windsurf_and_zed_in_path() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_cursor = tmp.path().join("cursor.cmd");
        std::fs::write(&fake_cursor, "@echo off\n").unwrap();
        let fake_windsurf = tmp.path().join("windsurf.cmd");
        std::fs::write(&fake_windsurf, "@echo off\n").unwrap();
        let fake_zed = tmp.path().join("zed.exe");
        std::fs::write(&fake_zed, "").unwrap();

        let path_os = tmp.path().as_os_str();
        assert!(find_windows_editor_with("com.todesktop.230313mzl4w4u92", Some(path_os)).is_some());
        assert!(find_windows_editor_with("com.exafunction.windsurf", Some(path_os)).is_some());
        assert!(find_windows_editor_with("dev.zed.Zed", Some(path_os)).is_some());
    }

    #[test]
    fn unknown_editor_returns_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            find_windows_editor_with("com.unknown.editor", Some(tmp.path().as_os_str())).is_none()
        );
    }

    #[cfg(windows)]
    #[test]
    fn detects_installed_zed_on_current_machine() {
        // Zed is installed on this dev machine
        let found = find_windows_editor("dev.zed.Zed");
        assert!(found.is_some(), "Zed should be detected on this machine");
    }
}
