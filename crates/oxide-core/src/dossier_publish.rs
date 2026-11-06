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

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::dossier::{VerificationDossier, VerificationState};
use crate::{CommandOutcome, Core, Error, PermissionMode, Result, git, github};

/// Opens the Dossier section in a pull request body.
pub const SECTION_START: &str = "<!-- oxide:dossier:start -->";
/// Closes the Dossier section in a pull request body.
pub const SECTION_END: &str = "<!-- oxide:dossier:end -->";

/// Records the branch commit a published section describes, so an update can tell whether the
/// section still matches the pull request's head.
const COMMIT_PREFIX: &str = "<!-- oxide:dossier:commit:";
/// Echoes the disclosure choices in the published section; refresh authority is stored locally,
/// never read back from this collaborator-editable PR body.
const OPTIONS_PREFIX: &str = "<!-- oxide:dossier:options:";

const REDACTED: &str = "[REDACTED]";

/// Most files or commits listed under one heading; the rest are counted.
const MAX_LISTED: usize = 20;
/// Most characters of one prompt or closing message; GitHub caps a whole body at 65,536.
const MAX_TEXT_CHARS: usize = 8_000;
/// GitHub's limit on a pull request body, in characters.
pub(crate) const MAX_BODY_CHARS: usize = 65_536;

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

/// Where the Dossier section in a pull request body stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DossierSectionState {
    /// The body has no section: never published here, or removed by hand.
    Missing,
    /// The section describes the pull request's head commit.
    UpToDate,
    /// The branch moved after the section was published.
    OutOfDate,
}

/// What a push from Oxide, or the user's refresh, did to a pull request's Dossier section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierUpdate {
    pub state: DossierUpdateState,
    /// The pull request the update was about, when one was found.
    pub pull_request: Option<u32>,
    /// Why an update failed, when it did. The push itself still succeeded.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DossierUpdateState {
    /// The section now describes the pushed branch.
    Updated,
    /// The section already described the pushed branch.
    UpToDate,
    /// The branch has no open pull request.
    NoPullRequest,
    /// The pull request body has no section; a removed one is not re-added.
    NoSection,
    /// The update failed; the push itself did not.
    Failed,
}

impl DossierUpdate {
    fn updated(pull_request: u32) -> Self {
        Self {
            state: DossierUpdateState::Updated,
            pull_request: Some(pull_request),
            message: None,
        }
    }

    fn up_to_date(pull_request: u32) -> Self {
        Self {
            state: DossierUpdateState::UpToDate,
            pull_request: Some(pull_request),
            message: None,
        }
    }

    fn no_pull_request() -> Self {
        Self {
            state: DossierUpdateState::NoPullRequest,
            pull_request: None,
            message: None,
        }
    }

    fn no_section(pull_request: u32) -> Self {
        Self {
            state: DossierUpdateState::NoSection,
            pull_request: Some(pull_request),
            message: None,
        }
    }

    fn failed(pull_request: Option<u32>, message: impl Into<String>) -> Self {
        Self {
            state: DossierUpdateState::Failed,
            pull_request,
            message: Some(message.into()),
        }
    }
}

impl Core {
    /// Remembers the author's explicit disclosure choices locally. PR-body comments are editable
    /// by collaborators and must never be treated as authority to publish Thread prompts.
    pub(crate) fn remember_dossier_options(
        &self,
        project_id: u32,
        thread_id: u32,
        number: u32,
        options: &DossierSectionOptions,
    ) -> Result<()> {
        let key = dossier_options_key(project_id, thread_id, number);
        let value = encode_options(options);
        let db = self.db.lock().unwrap_or_else(|error| error.into_inner());
        db.execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

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
            markdown: render_section(&dossier, options, git::head(&cwd).as_deref()),
            visibility,
        })
    }

    /// Updates the Dossier section of the branch's open pull request after a push from Oxide.
    /// Nothing here fails the push: a failure is returned for the app to report.
    pub(crate) fn update_published_dossier(
        &self,
        project_id: u32,
        thread_id: u32,
    ) -> DossierUpdate {
        let cwd = match self.git_target(project_id, Some(thread_id)) {
            Ok(target) => target.root,
            Err(error) => return DossierUpdate::failed(None, error.to_string()),
        };
        let found = github::current_pull_request_body(&self.gh, &cwd);
        let (number, body, head) = match found {
            Ok(Some(found)) => found,
            Ok(None) => return DossierUpdate::no_pull_request(),
            Err(error) => return DossierUpdate::failed(None, error.to_string()),
        };
        if head.is_empty() {
            return DossierUpdate::failed(
                Some(number),
                "GitHub did not report the pull request's head commit; the Dossier was not updated.",
            );
        }
        match self.republish_section(project_id, thread_id, number, &body, &head, false) {
            Ok(update) => update,
            Err(error) => DossierUpdate::failed(Some(number), error.to_string()),
        }
    }

    /// Recomputes and republishes a pull request's Dossier section because the user asked.
    /// Refuses a pull request whose section was removed rather than re-adding it.
    pub fn refresh_published_dossier(
        &self,
        project_id: u32,
        thread_id: u32,
        number: u32,
    ) -> Result<DossierUpdate> {
        let cwd = self.git_target(project_id, Some(thread_id))?.root;
        let (body, head) = github::pull_request_body_and_head(&self.gh, &cwd, number)?;
        if head.is_empty() {
            return Err(Error::Github(
                "GitHub did not report the pull request's head commit; the Dossier was not refreshed."
                    .into(),
            ));
        }
        // Publish evidence for the pull request's head, never for a checkout that is ahead or
        // behind it: a Dossier that describes another commit is worse than none.
        if git::head(&cwd).as_deref() != Some(head.as_str()) {
            return Err(Error::Github(
                "This checkout is not at the pull request's head; check the branch out and pull it \
                 before refreshing the Dossier."
                    .into(),
            ));
        }
        let update = self.republish_section(project_id, thread_id, number, &body, &head, true)?;
        if update.state == DossierUpdateState::NoSection {
            return Err(Error::Github(
                "This pull request has no Dossier section; a removed section is not re-added."
                    .into(),
            ));
        }
        Ok(update)
    }

    /// The one update path: replace the marked range of `body` with a section computed now.
    fn republish_section(
        &self,
        project_id: u32,
        thread_id: u32,
        number: u32,
        body: &str,
        expected_head: &str,
        explicit_refresh: bool,
    ) -> Result<DossierUpdate> {
        match markers(body) {
            Markers::None => return Ok(DossierUpdate::no_section(number)),
            // A half-deleted pair leaves text that reads as a Dossier but is not one. Say so
            // instead of silently leaving it, and never re-add what the author removed.
            Markers::Incomplete => {
                return Err(Error::Github(
                    "The Dossier markers are incomplete; remove the leftover marker or publish \
                     the section again."
                        .into(),
                ));
            }
            Markers::Complete => {}
        }
        if has_extra_section(body) {
            return Err(Error::Github(
                "The description has more than one Dossier section; remove the extra one before \
                 Oxide can update it."
                    .into(),
            ));
        }
        let current = section(body).expect("a complete pair of markers has a section");
        let cwd = self.git_target(project_id, Some(thread_id))?.root;
        // Bind both the evidence and its recorded commit to the GitHub head throughout dossier
        // computation.
        let head = git::head(&cwd).ok_or_else(|| {
            Error::Github("This checkout has no HEAD commit; the Dossier was not updated.".into())
        })?;
        if expected_head != head {
            return Err(Error::Github(
                "This checkout is not at the pull request's head; check the branch out and pull it \
                 before refreshing the Dossier."
                    .into(),
            ));
        }
        let saved_options = self.dossier_section_options(project_id, thread_id, number)?;
        if saved_options.is_none() && !explicit_refresh {
            return Err(Error::Github(
                "This device has no saved Dossier opt-in for this pull request. Refresh the section manually once to enable future updates."
                    .into(),
            ));
        }
        let options = saved_options.unwrap_or_default();
        let rendered_section =
            render_section(&self.branch_dossier(thread_id)?, &options, Some(&head));
        if git::head(&cwd).as_deref() != Some(head.as_str()) {
            return Err(Error::Github(
                "The checkout moved while the Dossier was being computed; refresh it again.".into(),
            ));
        }
        if explicit_refresh && saved_options.is_none() {
            // The user explicitly refreshed this section. Save the safe defaults locally so
            // future pushes may update it without trusting editable PR-body metadata.
            self.remember_dossier_options(project_id, thread_id, number, &options)?;
        }
        if rendered_section == current {
            return Ok(DossierUpdate::up_to_date(number));
        }
        if rendered_section.chars().count() > MAX_BODY_CHARS {
            return Err(Error::Github(format!(
                "The Dossier is longer than GitHub's {} characters.",
                MAX_BODY_CHARS
            )));
        }
        // Re-read immediately before writing so an edit outside the markers made while the
        // Dossier was computed is preserved. Refuse to overwrite a concurrently changed section
        // or a branch that moved on GitHub. GitHub has no conditional body update, so a final race
        // remains between this read and `gh pr edit`.
        let (latest_body, latest_head) =
            github::pull_request_body_and_head(&self.gh, &cwd, number)?;
        if expected_head != latest_head {
            return Err(Error::Github(
                "The pull request moved while the Dossier was being computed; refresh it again."
                    .into(),
            ));
        }
        if git::head(&cwd).as_deref() != Some(head.as_str()) {
            return Err(Error::Github(
                "The checkout moved while the Dossier was being computed; refresh it again.".into(),
            ));
        }
        if section(&latest_body) != Some(current) || has_extra_section(&latest_body) {
            return Err(Error::Github(
                "The Dossier section changed while it was being computed; refresh it again.".into(),
            ));
        }
        let updated = replace_section(&latest_body, &rendered_section)
            .ok_or_else(|| Error::Github("The Dossier markers are incomplete.".into()))?;
        if updated.chars().count() > MAX_BODY_CHARS {
            return Err(Error::Github(format!(
                "The description would be longer than GitHub's {} characters.",
                MAX_BODY_CHARS
            )));
        }
        github::edit_pull_request_body(&self.gh, &cwd, number, &updated)?;
        Ok(DossierUpdate::updated(number))
    }

    fn dossier_section_options(
        &self,
        project_id: u32,
        thread_id: u32,
        number: u32,
    ) -> Result<Option<DossierSectionOptions>> {
        let key = dossier_options_key(project_id, thread_id, number);
        let db = self.db.lock().unwrap_or_else(|error| error.into_inner());
        let recorded = db
            .query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                [&key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(recorded.as_deref().map(decode_options))
    }
}

fn dossier_options_key(project_id: u32, thread_id: u32, number: u32) -> String {
    format!("dossier_options:{project_id}:{thread_id}:{number}")
}

fn encode_options(options: &DossierSectionOptions) -> String {
    format!(
        "prompts={},message={}",
        options.include_prompts, options.include_agent_message
    )
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
pub(crate) fn without_section(body: &str) -> String {
    let Some(start) = body.find(SECTION_START) else {
        return body.to_string();
    };
    let Some(end) = body[start..].find(SECTION_END).map(|end| start + end) else {
        return body.to_string();
    };
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

/// How the Dossier markers in a body stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Markers {
    /// No start marker. A lone end marker is an invisible HTML comment and harmless.
    None,
    /// A start marker with no end marker after it.
    Incomplete,
    Complete,
}

fn markers(body: &str) -> Markers {
    let Some(start) = body.find(SECTION_START) else {
        return Markers::None;
    };
    if body[start..].find(SECTION_END).is_some() {
        Markers::Complete
    } else {
        Markers::Incomplete
    }
}

/// The delimited section of `body`, markers included. `None` unless both markers are present in
/// order.
pub(crate) fn section(body: &str) -> Option<&str> {
    if markers(body) != Markers::Complete {
        return None;
    }
    let start = body.find(SECTION_START)?;
    let end = body[start..].find(SECTION_END)? + start + SECTION_END.len();
    Some(&body[start..end])
}

/// Whether any Dossier marker remains after the first complete section.
fn has_extra_section(body: &str) -> bool {
    let Some(first) = section(body) else {
        return false;
    };
    let start = body.find(first).unwrap_or_default();
    let trailing = &body[start + first.len()..];
    trailing.contains(SECTION_START) || trailing.contains(SECTION_END)
}

/// `body` with the marked range replaced by `section`, leaving every byte outside it alone.
/// `None` when the body has no complete section.
pub(crate) fn replace_section(body: &str, section: &str) -> Option<String> {
    let start = body.find(SECTION_START)?;
    let end = body[start..].find(SECTION_END)? + start + SECTION_END.len();
    Some(format!("{}{section}{}", &body[..start], &body[end..]))
}

/// Where the Dossier section in `body` stands relative to the branch's `head` commit.
pub(crate) fn section_state(body: &str, head: &str) -> DossierSectionState {
    match markers(body) {
        Markers::None => DossierSectionState::Missing,
        // An incomplete pair or a pasted second section cannot be trusted to describe anything.
        Markers::Incomplete => DossierSectionState::OutOfDate,
        Markers::Complete if has_extra_section(body) => DossierSectionState::OutOfDate,
        Markers::Complete => match section(body).and_then(|s| metadata(s, COMMIT_PREFIX)) {
            Some(commit) if commit == head => DossierSectionState::UpToDate,
            _ => DossierSectionState::OutOfDate,
        },
    }
}

/// A saved consent record, or the safe default if it is missing or malformed.
fn decode_options(recorded: &str) -> DossierSectionOptions {
    let mut options = DossierSectionOptions::default();
    for pair in recorded.split(',') {
        match pair.split_once('=') {
            Some(("prompts", "true")) => options.include_prompts = true,
            Some(("message", "true")) => options.include_agent_message = true,
            _ => {}
        }
    }
    options
}

/// The text after an HTML-comment `prefix` inside `body`, up to the closing ` -->`.
fn metadata<'a>(body: &'a str, prefix: &str) -> Option<&'a str> {
    let start = body.find(prefix)? + prefix.len();
    let end = body[start..].find(" -->")? + start;
    Some(&body[start..end])
}

/// The delimited Markdown of a Dossier. It records the commit and echoes the disclosure choices;
/// local app state is authoritative for those choices during later updates.
pub(crate) fn render_section(
    dossier: &VerificationDossier,
    options: &DossierSectionOptions,
    commit: Option<&str>,
) -> String {
    let mut out = String::new();
    if let Some(commit) = commit.filter(|commit| !commit.is_empty()) {
        out.push_str(&format!("{COMMIT_PREFIX}{commit} -->\n"));
    }
    out.push_str(&format!(
        "{OPTIONS_PREFIX}prompts={},message={} -->\n",
        options.include_prompts, options.include_agent_message
    ));
    out.push_str("## Verification Dossier\n\n");
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
        if let Some(exit_code) = command.exit_code
            && command.outcome != Some(CommandOutcome::Succeeded)
        {
            line.push_str(&format!(", exit code {exit_code}"));
        }
        out.push_str(&line);
        out.push('\n');
    }

    if !dossier.signals.is_empty() {
        out.push_str("\n### Risk signals\n\n");
        for signal in &dossier.signals {
            out.push_str(&format!("- {}\n", plain(&signal.explanation)));
            for file in signal.files.iter().take(MAX_LISTED) {
                out.push_str(&format!("  - {}\n", code(file)));
            }
            if signal.files.len() > MAX_LISTED {
                out.push_str(&format!(
                    "  - and {} more\n",
                    signal.files.len() - MAX_LISTED
                ));
            }
        }
    }

    if !dossier.uncovered_commits.is_empty() {
        out.push_str("\n### Commits no Turn produced\n\n");
        for commit in dossier.uncovered_commits.iter().take(MAX_LISTED) {
            let sha: String = commit.sha.chars().take(7).collect();
            out.push_str(&format!(
                "- {} {}\n",
                code(&sha),
                code(&redact_command(&commit.subject))
            ));
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
    let mut text = clean(text);
    if let Some((cut, _)) = text.char_indices().nth(MAX_TEXT_CHARS) {
        text.truncate(cut);
        text.push_str("\n[truncated]");
    }
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

/// Flag names (without dashes, `_` read as `-`) whose value is a secret.
const SECRET_FLAGS: &[&str] = &[
    "token",
    "password",
    "passwd",
    "pass",
    "secret",
    "user",
    "api-key",
    "api-token",
    "apikey",
    "auth",
    "authorization",
    "access-key",
    "private-key",
    "secret-key",
    "credentials",
    "client-secret",
    "access-token",
    "auth-token",
    "bearer-token",
    "refresh-token",
    "id-token",
];

/// Flags whose value is a request body or form, which can carry a secret anywhere inside.
const BODY_FLAGS: &[&str] = &[
    "data",
    "data-raw",
    "data-binary",
    "data-urlencode",
    "json",
    "form",
];

/// Words that mark a header or query parameter as secret.
const SECRET_WORDS: &[&str] = &[
    "authorization",
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api-key",
    "api_key",
    "key",
    "sig",
    "signature",
    "cookie",
];

/// A command with environment assignments, credentials in URLs, headers and request bodies,
/// and secret-looking values replaced by `[REDACTED]`. Redaction is best effort on the text of a
/// command; a Project's own Verification commands are the only ones that reach it unlabelled.
pub(crate) fn redact_command(command: &str) -> String {
    let mut out = String::new();
    let mut redact_next = false;
    let mut previous = "";
    let mut program = String::new();
    let mut docker_login = false;
    let mut docker_seen = false;
    let mut password_cli = false;
    let mut shell_command = false;
    let mut rest = command;
    while !rest.is_empty() {
        let space_len = rest.len() - rest.trim_start().len();
        out.push_str(&rest[..space_len]);
        rest = &rest[space_len..];
        if rest.is_empty() {
            break;
        }
        let end = word_end(rest);
        let word = &rest[..end];
        rest = &rest[end..];
        let bare = word.trim_matches(|c| matches!(c, '"' | '\''));
        if program.is_empty() {
            program = bare.to_ascii_lowercase();
        }
        if bare.eq_ignore_ascii_case("docker") {
            docker_seen = true;
        } else if docker_seen && bare.eq_ignore_ascii_case("login") {
            docker_login = true;
        }
        password_cli |=
            ["mysql", "mariadb", "mongosh"].contains(&bare.to_ascii_lowercase().as_str());
        shell_command |= is_shell_program(bare);
        let separated_password = bare.eq_ignore_ascii_case("-p") && (docker_login || password_cli);
        let attached_password = bare.to_ascii_lowercase().starts_with("-p")
            && bare.len() > 2
            && (docker_login || password_cli);
        let shell_code_option = shell_command && is_shell_code_option(bare);
        if shell_code_option {
            shell_command = false;
        }
        let redacted = if redact_next {
            redact_next = false;
            Some(replace_value(word))
        } else if separated_password {
            redact_next = true;
            None
        } else if attached_password {
            Some(format!("-p{REDACTED}"))
        } else if shell_code_option {
            redact_next = true;
            Some(word.to_string())
        } else if previous == "-u" && word.contains(':') && !word.contains("//") {
            // `curl -u user:pass`; `git push -u origin` has no colon and stays.
            Some(replace_value(word))
        } else {
            redact_word(word, &mut redact_next)
        };
        out.push_str(&redacted.unwrap_or_else(|| word.to_string()));
        previous = word;
    }
    out
}

fn is_shell_program(word: &str) -> bool {
    let name = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
    ["sh", "bash", "zsh", "dash", "fish", "ksh", "ash"].contains(&name.as_str())
}

fn is_shell_code_option(word: &str) -> bool {
    let option = word.to_ascii_lowercase();
    option == "--command"
        || (option.starts_with('-')
            && !option.starts_with("--")
            && option[1..].chars().all(|ch| ch.is_ascii_alphabetic())
            && option[1..].contains('c'))
}

/// Where the shell word at the start of `text` ends: whitespace outside quotes.
fn word_end(text: &str) -> usize {
    let mut quote: Option<char> = None;
    for (i, c) in text.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_whitespace() => return i,
            None => {}
        }
    }
    text.len()
}

/// A secret word replaced, keeping the quotes that closed it so the command stays readable.
fn replace_value(word: &str) -> String {
    let closing: String = word
        .chars()
        .rev()
        .take_while(|c| matches!(c, '"' | '\'' | ';' | ')'))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let opening = word
        .chars()
        .next()
        .filter(|c| matches!(c, '"' | '\''))
        .map(String::from)
        .unwrap_or_default();
    format!("{opening}{REDACTED}{closing}")
}

fn flag_name(flag: &str) -> String {
    flag.trim_start_matches('-')
        .to_ascii_lowercase()
        .replace('_', "-")
}

fn redact_word(word: &str, redact_next: &mut bool) -> Option<String> {
    let bare = word.trim_matches(|c| matches!(c, '"' | '\''));
    if bare.eq_ignore_ascii_case("bearer") || bare.eq_ignore_ascii_case("basic") {
        *redact_next = true;
        return None;
    }
    if (bare.starts_with('{') || bare.starts_with('['))
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(bare)
        && json_has_secret_key(&value)
    {
        return Some(replace_value(word));
    }
    // `Authorization: Bearer x`, `X-Api-Key: x`, `"password": "x"` inside one quoted word.
    if let Some((name, value)) = bare.split_once(':')
        && !value.starts_with("//")
        && !name.contains(char::is_whitespace)
        && is_secret_name(name)
    {
        let quote = word.chars().next().filter(|c| matches!(c, '"' | '\''));
        let closing = quote.map(String::from).unwrap_or_default();
        let opening = quote.map(String::from).unwrap_or_default();
        return Some(format!("{opening}{name}: {REDACTED}{closing}"));
    }
    if bare.starts_with('-') && !bare.starts_with("---") {
        let (name, value) = match bare.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (bare, None),
        };
        if name.starts_with("--") {
            let flag = flag_name(name);
            if SECRET_FLAGS.contains(&flag.as_str()) || BODY_FLAGS.contains(&flag.as_str()) {
                return match value {
                    Some(_) => Some(format!("{name}={REDACTED}")),
                    None => {
                        *redact_next = true;
                        None
                    }
                };
            }
        }
    }
    if let Some((name, _)) = word.split_once('=')
        && is_env_name(name)
    {
        return Some(format!("{name}={REDACTED}"));
    }
    if let Some(scheme_end) = word.find("://") {
        let (scheme, rest) = (&word[..scheme_end], &word[scheme_end + 3..]);
        let (credentials, host) = match rest.find('@') {
            Some(at) if !rest[..at].contains('/') => (true, &rest[at + 1..]),
            _ => (false, rest),
        };
        let (host, query) = match host.split_once('?') {
            Some((host, query)) => (host, Some(query)),
            None => (host, None),
        };
        let query_secret = query.is_some_and(|q| {
            q.split('&')
                .any(|pair| pair.split_once('=').is_some_and(|(n, _)| is_secret_name(n)))
        });
        if credentials || query_secret {
            let userinfo = if credentials {
                format!("{REDACTED}@")
            } else {
                String::new()
            };
            let query = query
                .map(|q| {
                    let pairs: Vec<String> = q
                        .split('&')
                        .map(|pair| match pair.split_once('=') {
                            Some((n, _)) if is_secret_name(n) => format!("{n}={REDACTED}"),
                            _ => pair.to_string(),
                        })
                        .collect();
                    format!("?{}", pairs.join("&"))
                })
                .unwrap_or_default();
            return Some(format!("{scheme}://{userinfo}{host}{query}"));
        }
    }
    looks_secret(bare).then(|| replace_value(word))
}

fn json_has_secret_key(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(fields) => fields
            .iter()
            .any(|(name, value)| is_secret_name(name) || json_has_secret_key(value)),
        serde_json::Value::Array(values) => values.iter().any(json_has_secret_key),
        _ => false,
    }
}

/// Whether a header, query or JSON key names a secret.
fn is_secret_name(name: &str) -> bool {
    let raw = name.trim_matches(|c: char| matches!(c, '"' | '\'' | '{' | ' '));
    let chars: Vec<char> = raw.chars().collect();
    let mut normalized = String::with_capacity(raw.len());
    for (index, ch) in chars.iter().copied().enumerate() {
        if ch.is_ascii_uppercase() && index > 0 {
            let previous = chars[index - 1];
            let next_is_lower = chars
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_lowercase());
            let boundary = previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || (previous.is_ascii_uppercase() && next_is_lower);
            if boundary && !normalized.ends_with(['-', '_', ' ']) {
                normalized.push('-');
            }
        }
        normalized.push(ch.to_ascii_lowercase());
    }
    let words: Vec<&str> = normalized.split(['-', '_', ' ']).collect();
    SECRET_WORDS
        .iter()
        .any(|secret| normalized == *secret || words.contains(secret))
        || normalized.contains("apikey")
        || normalized.contains("api-key")
        || normalized.contains("api_key")
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
            r#"curl -H "Authorization: [REDACTED]" https://x.test"#
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
    fn quoted_values_headers_query_strings_and_bodies_are_redacted_whole() {
        let cases = [
            (r#"API_KEY='my secret value' run"#, "API_KEY=[REDACTED] run"),
            (
                r#"x --password "my pass" y"#,
                r#"x --password "[REDACTED]" y"#,
            ),
            (
                r#"curl -H "X-Api-Key: abc" u"#,
                r#"curl -H "X-Api-Key: [REDACTED]" u"#,
            ),
            (
                r#"curl -H "Authorization: token abc" u"#,
                r#"curl -H "Authorization: [REDACTED]" u"#,
            ),
            (
                "curl -u admin:hunter4 https://x.test",
                "curl -u [REDACTED] https://x.test",
            ),
            (
                r#"sh -c 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://x.test'"#,
                "sh -c '[REDACTED]'",
            ),
            (
                "curl https://x.test/a?access_token=abc&page=2",
                "curl https://x.test/a?access_token=[REDACTED]&page=2",
            ),
            (
                r#"curl -d '{"password":"x y"}' u"#,
                "curl -d '[REDACTED]' u",
            ),
            (
                r#"curl --data '{"password":"x y"}' u"#,
                "curl --data '[REDACTED]' u",
            ),
            ("mysql -phunter2 db", "mysql -p[REDACTED] db"),
            ("mysql -psecret db", "mysql -p[REDACTED] db"),
            ("docker login -p s3cr3t", "docker login -p [REDACTED]"),
            ("docker login -p=s3cr3t", "docker login -p[REDACTED]"),
            ("tool --api_key abc", "tool --api_key [REDACTED]"),
            ("tool --api-token abc123", "tool --api-token [REDACTED]"),
            (
                "tool --bearer-token abc123",
                "tool --bearer-token [REDACTED]",
            ),
            (r#"tool '{"refreshToken":"abc123"}'"#, "tool '[REDACTED]'"),
            (
                r#"tool '{"name":"build", "accessToken":"abc123"}'"#,
                "tool '[REDACTED]'",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_command(input), expected, "{input}");
        }
    }

    #[test]
    fn flags_that_only_resemble_secrets_keep_their_values() {
        for command in [
            "git commit --author \"A <a@b.c>\"",
            "cargo test --max-tokens 5",
            "git push -u origin feature",
            "cargo test -p oxide-core",
            "npm run build --no-auth",
        ] {
            assert_eq!(redact_command(command), command);
        }
    }

    #[test]
    fn a_stray_end_marker_before_the_section_does_not_stack_a_second_one() {
        let body = format!("a {SECTION_END} b\n\n{SECTION_START}\nold\n{SECTION_END}");
        let out = with_section(&body, "new");
        assert_eq!(out.matches(SECTION_START).count(), 1);
        assert!(out.contains("new") && !out.contains("old"));
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

    #[test]
    fn an_update_replaces_the_section_and_leaves_every_other_byte_alone() {
        let body = format!("  before  \n\n{SECTION_START}\nold\n{SECTION_END}\n\nafter\n\n");
        let new = format!("{SECTION_START}\nnew\n{SECTION_END}");
        assert_eq!(
            replace_section(&body, &new).unwrap(),
            format!("  before  \n\n{new}\n\nafter\n\n")
        );
        assert_eq!(replace_section("no markers here", &new), None);
    }

    #[test]
    fn incomplete_or_duplicated_markers_are_never_trusted_or_silently_rewritten() {
        let head = "abc123";
        let open = format!("Body\n\n{SECTION_START}\nold");
        assert_eq!(section(&open), None);
        assert_eq!(section_state(&open, head), DossierSectionState::OutOfDate);

        let twice = format!(
            "{SECTION_START}\n{COMMIT_PREFIX}{head} -->\nfirst\n{SECTION_END}\n\n\
             {SECTION_START}\n{COMMIT_PREFIX}other -->\nsecond\n{SECTION_END}"
        );
        assert_eq!(
            section_state(&twice, head),
            DossierSectionState::OutOfDate,
            "a second section must not be reported as up to date"
        );

        let dangling = format!(
            "{SECTION_START}\n{COMMIT_PREFIX}{head} -->\nfirst\n{SECTION_END}\n\n{SECTION_START}\nunfinished"
        );
        assert_eq!(
            section_state(&dangling, head),
            DossierSectionState::OutOfDate,
            "a dangling second marker must not be reported as up to date"
        );

        // Metadata outside the section cannot claim the section's commit.
        let forged = format!("{COMMIT_PREFIX}{head} -->\n\n{SECTION_START}\nold\n{SECTION_END}");
        assert_eq!(section_state(&forged, head), DossierSectionState::OutOfDate);
    }

    #[test]
    fn the_section_records_its_commit_and_the_options_it_was_published_with() {
        let dossier = VerificationDossier::default();
        let options = DossierSectionOptions {
            include_prompts: true,
            include_agent_message: false,
        };
        let section = render_section(&dossier, &options, Some("abc123"));

        assert_eq!(
            section_state(&section, "abc123"),
            DossierSectionState::UpToDate
        );
        assert_eq!(
            section_state(&section, "def456"),
            DossierSectionState::OutOfDate
        );
        assert_eq!(
            section_state("no section", "abc123"),
            DossierSectionState::Missing
        );
        assert!(section.contains(&format!("{OPTIONS_PREFIX}prompts=true,message=false -->")));
        assert_eq!(decode_options("prompts=true,message=false"), options);
        assert_eq!(
            decode_options("malformed"),
            DossierSectionOptions::default()
        );
    }
}
