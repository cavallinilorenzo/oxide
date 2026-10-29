//! Native font discovery and explicit Git/GitHub CLI setup. No webview shell access.
use crate::{Error, Result};
use oxide_provider::command::find_in;
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn resolve(program: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if cfg!(windows) {
        for name in ["ProgramFiles", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(name) {
                let root = PathBuf::from(root);
                dirs.extend([
                    root.join("Git/cmd"),
                    root.join("GitHub CLI"),
                    root.join("Programs/Git/cmd"),
                    root.join("Programs/GitHub CLI"),
                ]);
            }
        }
    }
    find_in(
        &std::env::join_paths(dirs).ok()?,
        program.as_ref(),
        std::env::var_os("PATHEXT").as_deref(),
    )
}

pub fn system_fonts() -> Result<Vec<String>> {
    #[cfg(windows)]
    let (program, args) = (
        "powershell.exe",
        vec![
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Drawing; $collection = [System.Drawing.Text.InstalledFontCollection]::new(); try { @($collection.Families | ForEach-Object { $_.Name }) | ConvertTo-Json -Compress } finally { $collection.Dispose() }",
        ],
    );
    #[cfg(target_os = "macos")]
    let (program, args) = ("system_profiler", vec!["SPFontsDataType", "-json"]);
    #[cfg(not(any(windows, target_os = "macos")))]
    let (program, args) = ("fc-list", vec!["--format=%{family}\\n"]);
    let output = oxide_provider::process::hide_console(Command::new(program).args(args))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::Editor(format!("Could not list installed fonts: {e}")))?;
    if !output.status.success() {
        return Err(Error::Editor(
            "Could not read system fonts. Try again after restarting Oxide.".into(),
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    #[cfg(windows)]
    let mut fonts: Vec<String> =
        serde_json::from_str(&text).map_err(|e| Error::Editor(e.to_string()))?;
    #[cfg(target_os = "macos")]
    let mut fonts = {
        fn collect(value: &serde_json::Value, fonts: &mut Vec<String>) {
            match value {
                serde_json::Value::Object(map) => {
                    if let Some(name) = map.get("family").and_then(|v| v.as_str()) {
                        fonts.push(name.to_string());
                    }
                    for value in map.values() {
                        collect(value, fonts);
                    }
                }
                serde_json::Value::Array(values) => {
                    for value in values {
                        collect(value, fonts);
                    }
                }
                _ => {}
            }
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| Error::Editor(e.to_string()))?;
        let mut fonts = Vec::new();
        collect(&value, &mut fonts);
        fonts
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut fonts: Vec<String> = text
        .lines()
        .flat_map(|l| l.split(','))
        .map(|s| s.trim().to_owned())
        .collect();
    fonts.retain(|f| !f.is_empty() && !f.starts_with('@'));
    fonts.sort_by_key(|f| f.to_lowercase());
    fonts.dedup();
    if fonts.is_empty() {
        return Err(Error::Editor(
            "The system returned no installed font families.".into(),
        ));
    }
    Ok(fonts)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperTool {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub can_install: bool,
    pub documentation: String,
}

pub fn developer_tools() -> Vec<DeveloperTool> {
    let manager = if cfg!(windows) { "winget" } else { "brew" };
    let can_install = (cfg!(windows) || cfg!(target_os = "macos")) && resolve(manager).is_some();
    [
        ("git", "Git", "https://git-scm.com/downloads"),
        ("gh", "GitHub CLI", "https://cli.github.com/"),
    ]
    .into_iter()
    .map(|(id, name, documentation)| {
        let path = resolve(id);
        DeveloperTool {
            id: id.into(),
            name: name.into(),
            installed: path.is_some(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
            can_install,
            documentation: documentation.into(),
        }
    })
    .collect()
}

pub fn install_developer_tool(tool: &str) -> Result<()> {
    let args = install_args(tool)?;
    static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _install = INSTALL.try_lock().map_err(|_| {
        Error::Github(
            "Another tool installation is running. Wait for it to finish, then check again.".into(),
        )
    })?;
    let manager = if cfg!(windows) { "winget" } else { "brew" };
    if !cfg!(windows) && !cfg!(target_os = "macos") {
        return Err(Error::Github(
            "Use the official installation guide for your Linux distribution, then check again."
                .into(),
        ));
    }
    if resolve(tool).is_some() {
        return Ok(());
    }
    let executable = resolve(manager).ok_or_else(|| {
        Error::Github(format!(
            "{manager} is unavailable. Open the official installation guide, then check again."
        ))
    })?;
    let output = oxide_provider::process::hide_console(Command::new(executable).args(args))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Error::Github(format!("Could not start installation: {e}")))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        return Err(Error::Github(format!(
            "Installation did not finish ({}). {details} Use the official installer or try again.",
            output.status
        )));
    }
    if resolve(tool).is_none() {
        return Err(Error::Github(
            "Installation finished. Restart Oxide to load the updated PATH, then check again."
                .into(),
        ));
    }
    Ok(())
}

fn install_args(tool: &str) -> Result<Vec<&'static str>> {
    let package = match tool {
        "git" => "Git.Git",
        "gh" => "GitHub.cli",
        _ => return Err(Error::Github("Unknown developer tool.".into())),
    };
    Ok(if cfg!(windows) {
        vec![
            "install",
            "--id",
            package,
            "--exact",
            "--source",
            "winget",
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
            "--disable-interactivity",
        ]
    } else {
        vec!["install", if tool == "git" { "git" } else { "gh" }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installer_accepts_only_fixed_tool_ids() {
        assert!(install_args("git").is_ok());
        assert!(install_args("gh").is_ok());
        for invalid in ["", "Git.Git", "git; calc", "--help"] {
            assert!(install_args(invalid).is_err());
        }
    }
}
