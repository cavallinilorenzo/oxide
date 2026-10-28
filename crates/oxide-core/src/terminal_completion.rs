use crate::terminal::TerminalSession;
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCompletion {
    pub replacement_index: usize,
    pub replacement_length: usize,
    pub matches: Vec<TerminalMatch>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMatch {
    pub text: String,
    pub label: String,
    pub detail: String,
}

pub fn complete(
    session: &TerminalSession,
    line: &str,
    cursor: usize,
    cwd: &str,
) -> Result<TerminalCompletion> {
    if line.len() > 64 * 1024 || cursor > line.encode_utf16().count() {
        return Err(Error::Terminal("Invalid completion position.".into()));
    }
    #[cfg(windows)]
    {
        use base64::Engine;
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::time::{Duration, Instant};
        static SEQUENCE: AtomicU32 = AtomicU32::new(1);
        let _ = cwd;
        let token = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let prefix = format!("\x1b]633;Oxide;complete;{token};");
        let input = base64::engine::general_purpose::STANDARD.encode(line);
        let script = format!(
            "$oxideLineText=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{input}')); $oxideCompletion=TabExpansion2 $oxideLineText {cursor}; $oxideResult=@{{replacementIndex=[Math]::Max(0,$oxideCompletion.ReplacementIndex); replacementLength=[Math]::Max(0,$oxideCompletion.ReplacementLength); matches=@($oxideCompletion.CompletionMatches | Select-Object -First 200 | ForEach-Object {{ @{{text=[string]$_.CompletionText; label=[string]$_.ListItemText; detail=[string]$_.ToolTip}} }})}} | ConvertTo-Json -Depth 5 -Compress; [Console]::Write(([char]27)+']633;Oxide;complete;{token};'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($oxideResult))+[char]7)\r"
        );
        let receiver = session.subscribe();
        session.write(script.as_bytes())?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut output = Vec::new();
        while Instant::now() < deadline {
            if let Ok(bytes) = receiver.recv_timeout(Duration::from_millis(100)) {
                output.extend(bytes);
            }
            if output.len() > 1024 * 1024 {
                break;
            }
            let text = String::from_utf8_lossy(&output);
            if let Some(start) = text.find(&prefix)
                && let Some(end) = text[start + prefix.len()..].find('\x07')
            {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&text[start + prefix.len()..start + prefix.len() + end])
                    .map_err(|error| Error::Terminal(error.to_string()))?;
                return serde_json::from_slice(&bytes).map_err(|error| {
                    Error::Terminal(format!("Invalid shell completion: {error}"))
                });
            }
        }
        Err(Error::Terminal(
            "Shell completion timed out. Try Tab again when the shell is idle.".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = session;
        Ok(path_completion(line, cursor, Path::new(cwd)))
    }
}

/// Files and PATH commands, without evaluating user input. Also used to test quoting on every OS.
#[cfg_attr(windows, allow(dead_code))]
fn path_completion(line: &str, cursor: usize, cwd: &Path) -> TerminalCompletion {
    let mut units = 0;
    let end = line
        .char_indices()
        .find_map(|(i, ch)| {
            if units == cursor {
                Some(i)
            } else {
                units += ch.len_utf16();
                None
            }
        })
        .unwrap_or(line.len());
    let input = &line[..end];
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    for (i, ch) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if Some(ch) == quote {
            quote = None;
        } else if quote.is_none() && (ch == '\'' || ch == '"') {
            quote = Some(ch);
        } else if quote.is_none() && ch.is_whitespace() {
            start = i + ch.len_utf8();
        }
    }
    let word = input[start..].trim_matches(['\'', '"']).replace("\\ ", " ");
    let (parent, prefix) = word
        .rsplit_once('/')
        .map(|(a, b)| (format!("{a}/"), b))
        .unwrap_or((String::new(), word.as_str()));
    let directory = if let Some(relative) = parent.strip_prefix("~/") {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_default()
            .join(relative)
    } else {
        cwd.join(&parent)
    };
    let mut matches = Vec::new();
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix) && (prefix.starts_with('.') || !name.starts_with('.')) {
                let directory = entry.file_type().is_ok_and(|t| t.is_dir());
                let text = format!("{parent}{name}{}", if directory { "/" } else { "" });
                let text = if text
                    .chars()
                    .any(|c| c.is_whitespace() || "'\"$`;()&|".contains(c))
                {
                    format!("'{}'", text.replace('\'', "'\"'\"'"))
                } else {
                    text
                };
                matches.push(TerminalMatch {
                    text,
                    label: format!("{name}{}", if directory { "/" } else { "" }),
                    detail: if directory {
                        "Directory".into()
                    } else {
                        "File".into()
                    },
                });
            }
        }
    }
    if start == 0 {
        for path in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with(prefix) && entry.file_type().is_ok_and(|t| t.is_file()) {
                        matches.push(TerminalMatch {
                            text: name.clone(),
                            label: name,
                            detail: "Command".into(),
                        });
                    }
                }
            }
        }
    }
    matches.sort_by(|a, b| a.text.cmp(&b.text));
    matches.dedup_by(|a, b| a.text == b.text);
    matches.truncate(200);
    TerminalCompletion {
        replacement_index: input[..start].encode_utf16().count(),
        replacement_length: cursor - input[..start].encode_utf16().count(),
        matches,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_completed_without_executing_input_and_spaces_are_quoted() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("some file.txt"), "").unwrap();
        let result = path_completion("cat so", 6, root.path());
        assert_eq!(result.replacement_index, 4);
        assert_eq!(result.matches[0].text, "'some file.txt'");
    }
}
