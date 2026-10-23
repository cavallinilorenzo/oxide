//! Getting a folder on disk ready to be registered as a Project: creating it with
//! `git init`, or cloning into it from a Git URL or GitHub.

use crate::{Error, Result, git};
use std::fs;
use std::path::{Path, PathBuf};

fn io(path: &Path) -> impl FnOnce(std::io::Error) -> Error + '_ {
    move |source| Error::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// A folder name that stays inside its parent.
fn checked_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        return Err(Error::Git(format!("`{name}` is not a valid folder name.")));
    }
    Ok(name)
}

/// The folder `parent/name`, which must not exist yet. Creates `parent` if needed.
fn fresh_folder(parent: &Path, name: &str) -> Result<PathBuf> {
    fs::create_dir_all(parent).map_err(io(parent))?;
    let dest = parent.join(checked_name(name)?);
    if dest.exists() {
        return Err(Error::Git(format!("{} already exists.", dest.display())));
    }
    Ok(dest)
}

/// A new folder `parent/name` holding a freshly initialised repository.
pub fn create(parent: &Path, name: &str) -> Result<PathBuf> {
    let dest = fresh_folder(parent, name)?;
    fs::create_dir(&dest).map_err(io(&dest))?;
    if let Err(e) = git::run(&dest, &["init", "-q"]) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    Ok(dest)
}

/// `https://host/owner/repo.git`, `git@host:owner/repo` or `/path/repo/` → `repo`.
pub fn repository_name(url: &str) -> Option<&str> {
    let last = url.trim().trim_end_matches('/').rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty()).then_some(name)
}

/// Clones `url` into `parent/<repository name>`.
pub fn clone_url(parent: &Path, url: &str) -> Result<PathBuf> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(Error::Git("Enter a Git URL to clone.".into()));
    }
    let name = repository_name(url)
        .ok_or_else(|| Error::Git(format!("Cannot tell the repository name from `{url}`.")))?;
    let dest = fresh_folder(parent, name)?;
    git::run(parent, &["clone", "-q", "--", url, &dest.to_string_lossy()])?;
    Ok(dest)
}

/// The folder a GitHub repository `owner/name` is cloned into: `parent/name`.
pub fn github_clone_target(parent: &Path, name_with_owner: &str) -> Result<PathBuf> {
    let valid = |part: &str| {
        !part.is_empty()
            && !part.starts_with('-')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    match name_with_owner.split_once('/') {
        Some((owner, name)) if valid(owner) && valid(name) => fresh_folder(parent, name),
        _ => Err(Error::Github(format!(
            "`{name_with_owner}` is not an owner/name repository."
        ))),
    }
}
