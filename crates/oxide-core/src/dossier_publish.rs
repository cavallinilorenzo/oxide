//! The Dossier as a section of a pull request's body, so the evidence reaches reviewers who do not
//! run Oxide and outlives the Thread it came from.
//!
//! The section holds facts Oxide computed. The Thread's prompts and the agent's closing message
//! are left out unless the author opts in for this pull request, and every command is redacted
//! before it is written: environment assignments and anything that looks like a secret. Free text
//! (commands, subjects, prompts) is always inside a code span or fence, so a stray `Closes #1`
//! in it never reaches GitHub's keyword parser and a stray marker never ends the section early.
//! The section is delimited by HTML comment markers; publishing replaces a previous section
//! instead of stacking a second one.

use serde::{Deserialize, Serialize};

use crate::dossier::{VerificationDossier, VerificationState};
use crate::{CommandOutcome, Core, PermissionMode, Result, github};

/// Opens the Dossier section in a pull request body.
pub const SECTION_START: &str = "<!-- oxide:dossier:start -->";
/// Closes the Dossier section in a pull request body.
pub const SECTION_END: &str = "<!-- oxide:dossier:end -->";

const REDACTED: &str = "[REDACTED]";

/// Who can read the repository a pull request is opened in, which decides who reads the section.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryVisibility {
    Public,
    Private,
    Internal,
    /// GitHub did not say. The preview treats it as possibly public.
    Unknown,
}

/// What the author opts in to for one pull request. Everything is off by default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierSectionOptions {
    /// Include the Thread's prompts as the author wrote them.
    pub include_prompts: bool,
    /// Include the agent's closing message, labelled as a claim.
    pub include_agent_message: bool,
}

/// The Dossier section ready to preview, with the visibility of the repository it will land in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierSection {
    /// The delimited Markdown that would be appended to the pull request body.
    pub markdown: String,
    pub visibility: RepositoryVisibility,
}

impl Core {
    /// The Dossier section for the pull request about to be opened from a Thread's branch,
    /// computed now and not stored.
    pub fn dossier_pull_request_section(
        &self,
        project_id: u32,
        thread_id: u32,
        options: &DossierSectionOptions,
    ) -> Result<DossierSection> {
        let dossier = self.branch_dossier(thread_id)?;
        let cwd = self.git_target(project_id, Some(thread_id))?.root;
        let visibility =
            github::repository_visibility(&self.gh, &cwd).unwrap_or(RepositoryVisibility::Unknown);
        Ok(DossierSection {
            markdown: render_section(&dossier, options),
            visibility,
        })
    }
}

/// `body` with `section` as its one Dossier section: a previous section is replaced, and an
/// empty section leaves the body as it was.
pub(crate) fn with_section(body: &str, section: &str) -> String {
    let body = without_section(body);
    let Some(section) = delimit(section) else {
        return body;
    };
    if body.trim().is_empty() {
        section
    } else {
        format!("{}\n\n{section}", body.trim_end())
    }
}

/// `body` without any text between the Dossier markers, markers included.
fn without_section(body: &str) -> String {
    let (Some(start), Some(end)) = (body.find(SECTION_START), body.find(SECTION_END)) else {
        return body.to_string();
    };
    if end < start {
        return body.to_string();
    }
    let after = &body[end + SECTION_END.len()..];
    let joined = format!("{}{}", body[..start].trim_end(), after);
    joined.trim_start_matches('\n').to_string()
}

/// `text` between the markers, whatever markers it already carried. `None` when nothing is left.
fn delimit(text: &str) -> Option<String> {
    let inner = text.replace(SECTION_START, "").replace(SECTION_END, "");
    let inner = inner.trim();
    (!inner.is_empty()).then(|| format!("{SECTION_START}\n{inner}\n{SECTION_END}"))
}

/// The delimited Markdown of a Dossier.
pub(crate) fn render_section(
    dossier: &VerificationDossier,
    options: &DossierSectionOptions,
) -> String {
    let mut out = String::from("## Verification Dossier\n\n");
    out.push_str(
        "_Computed by Oxide from the Thread's Transcript, Checkpoints and GitHub, without an LLM._\n",
    );

    out.push_str("\n### Verification commands\n\n");
    if dossier.commands.is_empty() {
        out.push_str("No Verification command ran.\n");
    }
    for command in &dossier.commands {
        let state = match command.state {
            VerificationState::Fresh => "fresh",
            VerificationState::Stale => "stale",
            VerificationState::Failed => "failed",
            VerificationState::NeverRun => "never run",
            VerificationState::Unknown => "unknown",
        };
        let mut line = format!("- {state}: {}", code(&redact_command(&command.command)));
        if let Some(turn) = command.turn_index {
            line.push_str(&format!(" (Turn {})", turn + 1));
        }
        if let Some(code_) = command.exit_code
            && command.outcome != Some(CommandOutcome::Succeeded)
        {
            line.push_str(&format!(", exit code {code_}"));
        }
        out.push_str(&line);
        out.push('\n');
    }

    if !dossier.signals.is_empty() {
        out.push_str("\n### Risk signals\n\n");
        for signal in &dossier.signals {
            out.push_str(&format!("- {}\n", plain(&signal.explanation)));
            for file in &signal.files {
                out.push_str(&format!("  - {}\n", code(file)));
            }
        }
    }

    if !dossier.uncovered_commits.is_empty() {
        out.push_str("\n### Commits no Turn produced\n\n");
        for commit in &dossier.uncovered_commits {
            let sha: String = commit.sha.chars().take(7).collect();
            out.push_str(&format!("- {} {}\n", code(&sha), code(&commit.subject)));
        }
    }

    let supervision = &dossier.supervision;
    out.push_str("\n### Supervision\n\n");
    out.push_str(&format!(
        "Approvals: {} granted, {} denied.",
        supervision.approvals_granted, supervision.approvals_denied
    ));
    if !supervision.permission_modes.is_empty() {
        let modes: Vec<String> = supervision
            .permission_modes
            .iter()
            .map(|used| {
                let mode = match used.mode {
                    Some(PermissionMode::Ask) => "ask",
                    Some(PermissionMode::AutoEdit) => "auto-edit",
                    Some(PermissionMode::FullAccess) => "full-access",
                    None => "unknown",
                };
                format!("{mode} ×{}", used.turns)
            })
            .collect();
        out.push_str(&format!(" Permission modes: {}.", modes.join(", ")));
    }
    out.push('\n');

    if options.include_prompts && !dossier.intent.prompts.is_empty() {
        out.push_str("\n### Prompts\n\n");
        for prompt in &dossier.intent.prompts {
            out.push_str(&fenced(prompt));
            out.push('\n');
        }
    }
    if options.include_agent_message
        && let Some(claim) = &dossier.claim
    {
        out.push_str("\n### Agent's closing message (a claim, not evidence)\n\n");
        out.push_str(&fenced(&claim.text));
        out.push('\n');
    }

    delimit(&out).unwrap_or_default()
}

/// Free text with the Dossier markers defused.
fn clean(text: &str) -> String {
    text.replace("oxide:dossier:", "oxide:dossier\u{200b}:")
}

/// A sentence Oxide wrote, safe to put on a list line.
fn plain(text: &str) -> String {
    clean(text).replace('\n', " ")
}

/// `text` as a single-line code span.
fn code(text: &str) -> String {
    let text = clean(text).replace('\n', " ");
    let ticks = "`".repeat(longest_run(&text, '`') + 1);
    let pad = if text.starts_with('`') || text.ends_with('`') {
        " "
    } else {
        ""
    };
    format!("{ticks}{pad}{text}{pad}{ticks}")
}

/// `text` as a fenced block longer than any fence inside it.
fn fenced(text: &str) -> String {
    let text = clean(text);
    let fence = "`".repeat((longest_run(&text, '`') + 1).max(3));
    format!("{fence}text\n{}\n{fence}", text.trim_end())
}

fn longest_run(text: &str, needle: char) -> usize {
    let (mut longest, mut run) = (0, 0);
    for c in text.chars() {
        run = if c == needle { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    longest
}

/// Flags whose next word is a secret.
const SECRET_FLAGS: &[&str] = &[
    "token",
    "password",
    "passwd",
    "secret",
    "api-key",
    "apikey",
    "auth",
    "authorization",
    "access-key",
    "private-key",
    "credentials",
];

/// A command with environment assignments, credentials in URLs and secret-looking values
/// replaced by `[REDACTED]`.
pub(crate) fn redact_command(command: &str) -> String {
    let mut out = String::new();
    let mut redact_next = false;
    for piece in command.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end();
        let space = &piece[word.len()..];
        if word.is_empty() {
            out.push_str(piece);
            continue;
        }
        let redacted = if redact_next {
            redact_next = false;
            Some(replace_value(word))
        } else {
            redact_word(word, &mut redact_next)
        };
        out.push_str(&redacted.unwrap_or_else(|| word.to_string()));
        out.push_str(space);
    }
    out
}

/// A secret word replaced, keeping a closing quote so the command stays readable.
fn replace_value(word: &str) -> String {
    let closing: String = word
        .chars()
        .rev()
        .take_while(|c| matches!(c, '"' | '\'' | ';' | ')'))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{REDACTED}{closing}")
}

fn redact_word(word: &str, redact_next: &mut bool) -> Option<String> {
    let bare = word.trim_matches(|c| matches!(c, '"' | '\''));
    if bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic") {
        *redact_next = true;
        return None;
    }
    if let Some(flag) = bare.strip_prefix("--") {
        let (name, value) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (flag, None),
        };
        if SECRET_FLAGS
            .iter()
            .any(|secret| name.to_ascii_lowercase().contains(secret))
        {
            return match value {
                Some(_) => Some(format!("--{name}={REDACTED}")),
                None => {
                    *redact_next = true;
                    None
                }
            };
        }
    }
    if let Some((name, _)) = word.split_once('=')
        && is_env_name(name)
    {
        return Some(format!("{name}={REDACTED}"));
    }
    if let Some(scheme_end) = word.find("://") {
        let rest = &word[scheme_end + 3..];
        if let Some(at) = rest.find('@')
            && !rest[..at].contains('/')
        {
            return Some(format!(
                "{}://{REDACTED}@{}",
                &word[..scheme_end],
                &rest[at + 1..]
            ));
        }
    }
    looks_secret(bare).then(|| replace_value(word))
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Token prefixes services use for credentials.
const SECRET_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "sk-",
    "sk_live_",
    "pk_live_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "AKIA",
    "ASIA",
    "AIza",
    "npm_",
    "pypi-",
    "eyJ",
];

fn looks_secret(word: &str) -> bool {
    if SECRET_PREFIXES
        .iter()
        .any(|prefix| word.starts_with(prefix))
        && word.len() >= 12
    {
        return true;
    }
    // A long run of token characters mixing letters and digits is a key, not a path or a word.
    word.len() >= 32
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '='))
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_assignments_lose_their_values() {
        assert_eq!(
            redact_command("DATABASE_URL=postgres://u:p@h/db RUST_LOG=debug cargo test"),
            "DATABASE_URL=[REDACTED] RUST_LOG=[REDACTED] cargo test"
        );
        assert_eq!(
            redact_command("export API_KEY=abc"),
            "export API_KEY=[REDACTED]"
        );
    }

    #[test]
    fn secret_flags_and_tokens_are_redacted_and_plain_commands_are_not() {
        assert_eq!(
            redact_command("deploy --token abc123 --dry-run"),
            "deploy --token [REDACTED] --dry-run"
        );
        assert_eq!(
            redact_command("deploy --password=hunter2"),
            "deploy --password=[REDACTED]"
        );
        assert_eq!(
            redact_command("gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "gh auth login --with-token [REDACTED]"
        );
        assert_eq!(
            redact_command(r#"curl -H "Authorization: Bearer abc.def" https://x.test"#),
            r#"curl -H "Authorization: Bearer [REDACTED]" https://x.test"#
        );
        assert_eq!(
            redact_command("git clone https://user:pass@github.com/o/r.git"),
            "git clone https://[REDACTED]@github.com/o/r.git"
        );
        assert_eq!(
            redact_command("cargo test -p oxide-core -- --nocapture"),
            "cargo test -p oxide-core -- --nocapture"
        );
        assert_eq!(
            redact_command("git commit -m \"a=b\""),
            "git commit -m \"a=b\""
        );
    }

    #[test]
    fn a_section_replaces_the_previous_one_and_an_empty_one_changes_nothing() {
        let first = with_section("Body", "one");
        assert_eq!(
            first,
            format!("Body\n\n{SECTION_START}\none\n{SECTION_END}")
        );
        let second = with_section(&first, "two");
        assert_eq!(
            second,
            format!("Body\n\n{SECTION_START}\ntwo\n{SECTION_END}")
        );
        assert_eq!(with_section("Body", "  "), "Body");
        assert_eq!(
            with_section("", "x"),
            format!("{SECTION_START}\nx\n{SECTION_END}")
        );
    }
}
