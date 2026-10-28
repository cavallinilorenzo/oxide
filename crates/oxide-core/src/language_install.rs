//! User-local language support, downloaded only after an explicit Install action.
use crate::{Error, LanguageServerConfig, Result};
use reqwest::blocking::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MAX_DOWNLOAD: u64 = 400 * 1024 * 1024;
fn error(message: impl ToString) -> Error {
    Error::Editor(message.to_string())
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

pub fn install(home: &Path, language: &str, progress: &impl Fn(&str)) -> Result<()> {
    let tools = home.join("tools");
    std::fs::create_dir_all(&tools).map_err(error)?;
    let temporary = tempfile::tempdir_in(&tools).map_err(error)?;
    let client = Client::builder()
        .user_agent("Oxide-language-support/0.1")
        .timeout(Duration::from_secs(300))
        .https_only(true)
        .build()
        .map_err(error)?;
    progress("Preparing language support…");
    let previous = crate::language_server::tools(home)
        .into_iter()
        .find(|t| t.language == language);
    let interpreter = previous.and_then(|t| t.config.interpreter);
    let (command, args) = match language {
        "python" | "typescript" => {
            install_npm(&client, home, temporary.path(), language, progress)?;
            let name = if language == "python" {
                "pyright-langserver"
            } else {
                "typescript-language-server"
            };
            let shim = if cfg!(windows) {
                format!("{name}.cmd")
            } else {
                name.into()
            };
            (
                home.join("tools/language-servers/node_modules/.bin")
                    .join(shim),
                vec!["--stdio".into()],
            )
        }
        "cpp" | "rust" => {
            let repository = if language == "cpp" {
                "clangd/clangd"
            } else {
                "rust-lang/rust-analyzer"
            };
            progress("Checking the official release…");
            let release: Release = client
                .get(format!(
                    "https://api.github.com/repos/{repository}/releases/latest"
                ))
                .send()
                .map_err(error)?
                .error_for_status()
                .map_err(error)?
                .json()
                .map_err(error)?;
            let executable = if language == "cpp" {
                "clangd"
            } else {
                "rust-analyzer"
            };
            let asset = release.assets.iter().find(|asset| supported_asset(language, &asset.name)).ok_or_else(|| error("No official binary is available for this operating system / architecture. Set a custom executable in Language tools."))?;
            if !asset.browser_download_url.starts_with(&format!(
                "https://github.com/{repository}/releases/download/"
            )) {
                return Err(error("Unexpected language server download URL."));
            }
            let archive = temporary.path().join(&asset.name);
            download(
                &client,
                &asset.browser_download_url,
                &archive,
                asset
                    .digest
                    .as_deref()
                    .and_then(|d| d.strip_prefix("sha256:")),
                progress,
            )?;
            progress("Unpacking language support…");
            let extracted = temporary.path().join("unpacked");
            std::fs::create_dir_all(&extracted).map_err(error)?;
            if asset.name.ends_with(".zip") {
                extract_zip(&archive, &extracted)?;
            } else {
                let mut reader = flate2::read::GzDecoder::new(File::open(&archive).map_err(error)?);
                let mut file = File::create(extracted.join(executable)).map_err(error)?;
                std::io::copy(&mut Read::by_ref(&mut reader).take(MAX_DOWNLOAD), &mut file)
                    .map_err(error)?;
            }
            let executable_name = if cfg!(windows) {
                format!("{executable}.exe")
            } else {
                executable.into()
            };
            let relative = find_executable(&extracted, &executable_name, 5)
                .ok_or_else(|| {
                    error("The download did not contain the language server executable.")
                })?
                .strip_prefix(&extracted)
                .map_err(error)?
                .to_path_buf();
            let version = release
                .tag_name
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.')
                .collect::<String>();
            if version.is_empty() {
                return Err(error("Invalid release version."));
            }
            let destination = tools.join(executable).join(version);
            std::fs::create_dir_all(destination.parent().unwrap()).map_err(error)?;
            if !destination.exists() {
                std::fs::rename(&extracted, &destination).map_err(error)?;
            }
            let binary = destination.join(relative);
            make_executable(&binary)?;
            (binary, vec![])
        }
        _ => return Err(error("Unsupported language support.")),
    };
    if !command.is_file() {
        return Err(error(
            "Installation did not create the language server. Check your connection and try again.",
        ));
    }
    crate::language_server::configure(
        home,
        language,
        LanguageServerConfig {
            command: command.to_string_lossy().into_owned(),
            args,
            interpreter,
        },
    )?;
    progress("Installed. Connecting to your open files…");
    Ok(())
}

fn supported_asset(language: &str, name: &str) -> bool {
    if language == "cpp" {
        let platform = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "mac"
        } else {
            "linux"
        };
        // Upstream's Linux clangd zip is x86_64; ARM Linux uses a user-supplied server.
        if cfg!(all(target_os = "linux", not(target_arch = "x86_64"))) {
            return false;
        }
        name.starts_with(&format!("clangd-{platform}-")) && name.ends_with(".zip")
    } else {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else {
            return false;
        };
        let target = if cfg!(windows) {
            "pc-windows-msvc.zip"
        } else if cfg!(target_os = "macos") {
            "apple-darwin.gz"
        } else {
            "unknown-linux-gnu.gz"
        };
        name == format!("rust-analyzer-{arch}-{target}")
    }
}

fn download(
    client: &Client,
    url: &str,
    destination: &Path,
    expected: Option<&str>,
    progress: &impl Fn(&str),
) -> Result<()> {
    let mut response = client
        .get(url)
        .send()
        .map_err(error)?
        .error_for_status()
        .map_err(error)?;
    if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD) {
        return Err(error("Download is larger than the supported limit."));
    }
    let total = response.content_length();
    let mut received = 0;
    let mut announced = 0;
    let mut hash = Sha256::new();
    let mut file = File::create(destination).map_err(error)?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = response.read(&mut buffer).map_err(error)?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > MAX_DOWNLOAD {
            return Err(error("Download exceeded the supported limit."));
        }
        file.write_all(&buffer[..count]).map_err(error)?;
        hash.update(&buffer[..count]);
        if received - announced >= 2 * 1024 * 1024 {
            announced = received;
            progress(&match total {
                Some(total) if total > 0 => format!("Downloading… {}%", received * 100 / total),
                _ => format!("Downloading… {} MiB", received / 1024 / 1024),
            });
        }
    }
    if let Some(expected) = expected
        && format!("{:x}", hash.finalize()) != expected.to_ascii_lowercase()
    {
        return Err(error(
            "The downloaded file failed checksum verification. Try again.",
        ));
    }
    Ok(())
}

fn extract_zip(archive: &Path, root: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(error)?).map_err(error)?;
    let mut total: u64 = 0;
    if zip.len() > 30000 {
        return Err(error("Archive contains too many files."));
    }
    for n in 0..zip.len() {
        let mut entry = zip.by_index(n).map_err(error)?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| error("Archive path leaves the installation directory."))?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(error("Archive contains a symbolic link."));
        }
        total = total.saturating_add(entry.size());
        if total > 1024 * 1024 * 1024 {
            return Err(error("Expanded archive exceeds 1 GiB."));
        }
        let target = root.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(error)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(error)?;
            }
            let mut file = File::create(&target).map_err(error)?;
            std::io::copy(&mut entry, &mut file).map_err(error)?;
        }
    }
    Ok(())
}
fn find_executable(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && entry.file_name() == name {
            return Some(path);
        }
        if path.is_dir()
            && let Some(found) = find_executable(&path, name, depth - 1)
        {
            return Some(found);
        }
    }
    None
}
fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(error)?;
    }
    let _ = path;
    Ok(())
}

fn install_npm(
    client: &Client,
    home: &Path,
    temporary: &Path,
    language: &str,
    progress: &impl Fn(&str),
) -> Result<()> {
    let node_root = home.join("tools/node");
    let managed_node = node_root.join(if cfg!(windows) {
        "node.exe"
    } else {
        "bin/node"
    });
    let path = std::env::var_os("PATH").unwrap_or_default();
    let system_npm = oxide_provider::command::find_in(
        &path,
        std::ffi::OsStr::new("npm"),
        std::env::var_os("PATHEXT").as_deref(),
    );
    if !managed_node.exists() && system_npm.is_none() {
        progress("Installing a private Node.js runtime for language tools…");
        let releases: Vec<serde_json::Value> = client
            .get("https://nodejs.org/dist/index.json")
            .send()
            .map_err(error)?
            .error_for_status()
            .map_err(error)?
            .json()
            .map_err(error)?;
        let release = releases
            .iter()
            .find(|r| r["lts"].is_string())
            .and_then(|r| r["version"].as_str())
            .ok_or_else(|| error("No Node.js LTS release found."))?;
        if !release.starts_with('v')
            || !release[1..].chars().all(|c| c.is_ascii_digit() || c == '.')
        {
            return Err(error("Invalid Node.js version."));
        }
        let platform = if cfg!(windows) {
            "win"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else if cfg!(target_arch = "x86_64") {
            "x64"
        } else {
            return Err(error("Set a custom language server on this architecture."));
        };
        let extension = if cfg!(windows) { "zip" } else { "tar.gz" };
        let name = format!("node-{release}-{platform}-{arch}.{extension}");
        let checksums = client
            .get(format!("https://nodejs.org/dist/{release}/SHASUMS256.txt"))
            .send()
            .map_err(error)?
            .error_for_status()
            .map_err(error)?
            .text()
            .map_err(error)?;
        let checksum = checksums
            .lines()
            .find_map(|line| {
                let (hash, file) = line.split_once(' ')?;
                (file.trim() == name).then_some(hash)
            })
            .ok_or_else(|| error("Missing Node.js checksum."))?;
        let archive = temporary.join(&name);
        download(
            client,
            &format!("https://nodejs.org/dist/{release}/{name}"),
            &archive,
            Some(checksum),
            progress,
        )?;
        let extracted = temporary.join("node");
        std::fs::create_dir_all(&extracted).map_err(error)?;
        if cfg!(windows) {
            extract_zip(&archive, &extracted)?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(
                File::open(&archive).map_err(error)?,
            ))
            .unpack(&extracted)
            .map_err(error)?;
        }
        let source = extracted.join(format!("node-{release}-{platform}-{arch}"));
        std::fs::rename(source, &node_root).map_err(error)?;
        make_executable(&managed_node)?;
    }
    progress("Installing language packages…");
    let mut command = if managed_node.exists() {
        let npm = node_root.join(if cfg!(windows) {
            "node_modules/npm/bin/npm-cli.js"
        } else {
            "lib/node_modules/npm/bin/npm-cli.js"
        });
        let mut command = Command::new(&managed_node);
        command.arg(npm);
        command
    } else {
        Command::new(system_npm.ok_or_else(|| error("npm was not found."))?)
    };
    let prefix = home.join("tools/language-servers");
    command
        .args(["install", "--no-audit", "--no-fund", "--prefix"])
        .arg(&prefix);
    if language == "python" {
        command.arg("pyright@1.1.414");
    } else {
        // TypeScript 7 is native and no longer ships tsserver.js. This LSP server
        // requires the JavaScript SDK; prefer a Project SDK at initialization, then this fallback.
        command.args(["typescript@6.0.3", "typescript-language-server@6.0.2"]);
    }
    let mut paths = vec![node_root.clone(), node_root.join("bin")];
    paths.extend(std::env::split_paths(&path));
    command.env("PATH", std::env::join_paths(paths).map_err(error)?);
    let output = oxide_provider::process::output_in_own_group(&mut command).map_err(error)?;
    if !output.status.success() {
        return Err(error(format!(
            "Language package installation failed: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zip_extraction_rejects_paths_outside_install_root() {
        let temporary = tempfile::tempdir().unwrap();
        let archive = temporary.path().join("bad.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file("../escape", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"no").unwrap();
        writer.finish().unwrap();
        assert!(extract_zip(&archive, &temporary.path().join("extract")).is_err());
        assert!(!temporary.path().parent().unwrap().join("escape").exists());
    }
    #[test]
    fn only_the_runtime_asset_for_this_platform_is_selected() {
        assert!(!supported_asset(
            "cpp",
            "clangd-debug-symbols-windows-23.1.0.7z"
        ));
        assert!(!supported_asset("rust", "rust-analyzer-win32-x64.vsix"));
    }
}
