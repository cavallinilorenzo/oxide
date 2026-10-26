//! Finds the slash commands and skills a Claude Code session would load from the user's
//! customizations, so the composer can list them before a session (and its `init` message) exists.

use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    /// Name without the leading `/`.
    pub name: String,
    pub description: Option<String>,
}

/// Commands and skills from `<user_home>/.claude` and `<project>/.claude`; a project entry
/// overrides a user one of the same name. Sorted by name.
pub fn discover(user_home: &Path, project: Option<&Path>) -> Vec<SlashCommand> {
    let mut found: Vec<SlashCommand> = Vec::new();
    let mut roots = vec![user_home.join(".claude")];
    if let Some(p) = project {
        roots.push(p.join(".claude"));
    }
    for root in roots {
        let mut here = Vec::new();
        collect_commands(&root.join("commands"), "", &mut here);
        collect_skills(&root.join("skills"), &mut here);
        for cmd in here {
            found.retain(|c| c.name != cmd.name);
            found.push(cmd);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

/// `commands/**/*.md`; a subfolder becomes a `folder:` namespace.
fn collect_commands(dir: &Path, prefix: &str, out: &mut Vec<SlashCommand>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            collect_commands(&path, &format!("{prefix}{file_name}:"), out);
        } else if let Some(stem) = file_name.strip_suffix(".md") {
            let meta = fs::read_to_string(&path)
                .map(|s| frontmatter(&s))
                .unwrap_or_default();
            out.push(SlashCommand {
                name: format!("{prefix}{stem}"),
                description: meta.description,
            });
        }
    }
}

/// `skills/<dir>/SKILL.md`, named by its frontmatter `name` or else the folder.
fn collect_skills(dir: &Path, out: &mut Vec<SlashCommand>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(text) = fs::read_to_string(entry.path().join("SKILL.md")) else {
            continue;
        };
        let meta = frontmatter(&text);
        out.push(SlashCommand {
            name: meta
                .name
                .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned()),
            description: meta.description,
        });
    }
}

#[derive(Default)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
}

fn frontmatter(text: &str) -> Frontmatter {
    let mut meta = Frontmatter::default();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return meta;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value
            .trim()
            .trim_matches(|c| c == '"' || c == '\'')
            .to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "name" => meta.name = Some(value),
            "description" => meta.description = Some(value),
            _ => {}
        }
    }
    meta
}
