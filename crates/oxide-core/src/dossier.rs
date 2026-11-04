//! The Verification Dossier: which commands count as checks for a Thread, and whether the result
//! of each still applies to the files as they are now, plus the branch-wide evidence: commits no
//! Turn produced, the pull request's checks and how much supervision the work had. Computed every
//! time from the Transcript, the Checkpoints, Git, GitHub and the Project's Verification
//! commands; never persisted, never run, no LLM.
//!
//! A command is fresh only if it succeeded after the last known change. Within a Turn the order of
//! Items says whether a FileChange came after the command. Across Turns and human edits, the tree
//! at the end of the command's Turn must match the working tree. A Turn whose Checkpoint diff
//! includes files that no FileChange Item names (a shell edit, say) makes freshness unknown rather
//! than fresh, because Oxide cannot tell when those files changed.
//!
//! Beside the commands the Dossier lists separate risk signals computed from the files the
//! Thread's Turns changed: a changed language no Verification command covers, source without a
//! test change, a sensitive path, and a diff over the line threshold. Each signal explains itself
//! in one sentence and points at the files in the Diff; none of them is combined into a score.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::git_diff::{Diff, DiffFile};
use crate::github::PullRequestCheck;
use crate::thread::{ItemSnapshot, TurnSnapshot};
use crate::{CommandOutcome, Core, ItemKind, PermissionMode, Result, checkpoint, git, git_diff};

/// Changed lines past which the Dossier flags a change as large.
pub const LARGE_DIFF_LINES: u32 = 400;

/// Gitignore-style patterns for CI configuration, flagged by default as sensitive.
const CI_SENSITIVE: &[&str] = &[
    ".github/workflows/",
    ".github/actions/",
    ".gitlab-ci.yml",
    ".circleci/",
    ".buildkite/",
    ".drone.yml",
    "azure-pipelines.yml",
    "azure-pipelines.yaml",
    "bitbucket-pipelines.yml",
    "appveyor.yml",
    "Jenkinsfile",
];

/// Gitignore-style patterns for dependency manifests and lockfiles, flagged by default.
const DEPENDENCY_SENSITIVE: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "deno.json",
    "deno.lock",
    "pyproject.toml",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock",
    "requirements.txt",
    "requirements-*.txt",
    "go.mod",
    "go.sum",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "mix.exs",
    "mix.lock",
    "pubspec.yaml",
    "pubspec.lock",
    "Package.swift",
    "Package.resolved",
    "*.csproj",
    "*.fsproj",
    "*.vbproj",
    "*.sln",
    "Directory.Build.props",
    "Directory.Packages.props",
    "vcpkg.json",
    "conanfile.txt",
    "conanfile.py",
];

/// Paths under which migrations usually live, flagged by default.
const MIGRATION_SENSITIVE: &[&str] = &[
    "migrations/",
    "migration/",
    "db/migrate/",
    "**/db/migrate/",
    "**/migrations/",
];

/// How much the evidence behind a Verification command can be trusted now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationState {
    /// It succeeded after the last change, and the tree still matches that Turn.
    Fresh,
    /// It succeeded, but files changed after it.
    Stale,
    /// Its most recent run failed.
    Failed,
    /// It is a Project's Verification command that no Turn ran.
    NeverRun,
    /// Oxide cannot tell: the Provider reported no outcome, or the Turn changed files it could not
    /// attribute to a FileChange Item.
    Unknown,
}

/// What kind of check a Verification command is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationKind {
    Test,
    Lint,
    TypeCheck,
    Build,
    /// A Project's own command that no built-in pattern recognizes.
    Other,
}

/// One Verification command of a Thread, with the state of its most recent evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCommand {
    /// The canonical command: what ran, or what the Project declared.
    pub command: String,
    pub kind: VerificationKind,
    pub state: VerificationState,
    /// The Turn of the most recent run; `None` for a command that never ran.
    pub turn_index: Option<u32>,
    /// The outcome the Provider reported for the most recent run.
    pub outcome: Option<CommandOutcome>,
    /// The exit code the Provider reported for the most recent run.
    pub exit_code: Option<i32>,
}

/// A commit on the branch that no Turn of the Thread accounts for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCommit {
    pub sha: String,
    pub subject: String,
}

/// The pull request of the Thread's branch, with the checks GitHub reports for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierPullRequest {
    pub number: u32,
    pub url: String,
    pub checks: Vec<PullRequestCheck>,
}

/// One Permission mode and how many Turns started in it; `None` is a Turn stored before it was
/// recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionModeUse {
    pub mode: Option<PermissionMode>,
    pub turns: u32,
}

/// How much supervision the work actually had.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Supervision {
    pub approvals_granted: u32,
    pub approvals_denied: u32,
    /// Known modes first, then Turns whose mode was never recorded.
    pub permission_modes: Vec<PermissionModeUse>,
}

/// What kind of risk a signal points at. Each kind explains itself; there is no aggregate score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskSignalKind {
    /// A language the change touches that no Verification command ran for.
    UncheckedLanguage,
    /// Source files changed, but no test file did.
    SourceWithoutTests,
    /// A changed file matches a sensitive path (CI, dependency manifests, migrations or a
    /// Project's own additions).
    SensitivePath,
    /// The change is larger than the line threshold.
    LargeDiff,
}

/// One risk signal, with the files in the Diff it points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskSignal {
    pub kind: RiskSignalKind,
    /// One sentence a reviewer can read on its own.
    pub explanation: String,
    /// The changed files the signal points at, relative to the checkout, in path order.
    pub files: Vec<String>,
    /// The language an [`RiskSignalKind::UncheckedLanguage`] signal is about.
    pub language: Option<String>,
    /// The line threshold an [`RiskSignalKind::LargeDiff`] signal crossed.
    pub threshold: Option<u32>,
}

/// What was asked for: the stored issue reference and the Thread's own prompts, never a summary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierIntent {
    pub issue: Option<DossierIssue>,
    /// The Thread's prompts in order, as the user wrote them.
    pub prompts: Vec<String>,
}

/// The GitHub issue a Board Thread was started from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DossierIssue {
    pub number: u32,
    /// The title stored when the Thread was dispatched; `None` for an older Thread.
    pub title: Option<String>,
    /// The issue's page on GitHub, stored when the Thread was dispatched.
    pub url: Option<String>,
}

/// The closing message of the agent, kept apart from what Oxide computed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClaim {
    pub turn_index: u32,
    pub text: String,
}

/// The Dossier of one Thread: its Verification commands and risk signals, the branch evidence no
/// Turn covers, the pull request's checks and the supervision the work had.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationDossier {
    /// Risk first: failed, stale, unknown, never run, then fresh. Ties by command.
    pub commands: Vec<VerificationCommand>,
    /// Separate, self-explaining signals about what stayed uncovered and where to look first.
    /// Deliberately no single risk score.
    pub signals: Vec<RiskSignal>,
    /// What was asked: the issue and prompts, not an LLM summary.
    pub intent: DossierIntent,
    /// The agent's closing message. It is never evidence and never changes `commands`.
    pub claim: Option<AgentClaim>,
    /// What the Branch scope compares against; `None` when there is no base branch.
    pub base_branch: Option<String>,
    /// Whether the branch could be compared with its base, so coverage is meaningful.
    pub coverage_known: bool,
    /// Commits since the merge-base that fall outside every recorded Turn.
    pub uncovered_commits: Vec<BranchCommit>,
    /// The branch's pull request, when GitHub reports one.
    pub pull_request: Option<DossierPullRequest>,
    /// Whether GitHub answered: `pull_request` being `None` then means the branch has none.
    pub pull_request_known: bool,
    /// Approvals and the Permission modes the Turns used.
    pub supervision: Supervision,
}

impl Core {
    /// The Project's own Verification commands, in the order they were saved.
    pub fn project_verification_commands(&self, project_id: u32) -> Result<Vec<String>> {
        self.project_string_list(project_id, "verification_commands")
    }

    /// Replaces the Project's own Verification commands. Blank lines are dropped and duplicates
    /// collapse, so the Dossier lists each command once.
    pub fn set_project_verification_commands(
        &self,
        project_id: u32,
        commands: &[String],
    ) -> Result<()> {
        let mut seen = HashSet::new();
        let commands: Vec<String> = commands
            .iter()
            .map(|command| command.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|command| !command.is_empty() && seen.insert(command.clone()))
            .collect();
        self.set_project_string_list(project_id, "verification_commands", commands)
    }

    /// The Project's own sensitive paths, in the order they were saved. The built-in CI,
    /// dependency manifest and migration patterns are matched beside these.
    pub fn project_sensitive_paths(&self, project_id: u32) -> Result<Vec<String>> {
        self.project_string_list(project_id, "sensitive_paths")
    }

    /// Replaces the Project's own sensitive paths. Blank lines are dropped and duplicates collapse,
    /// so the Dossier matches each pattern once.
    pub fn set_project_sensitive_paths(&self, project_id: u32, paths: &[String]) -> Result<()> {
        let mut seen = HashSet::new();
        let paths: Vec<String> = paths
            .iter()
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty() && seen.insert(path.clone()))
            .collect();
        self.set_project_string_list(project_id, "sensitive_paths", paths)
    }

    /// A Project column holding a JSON array of strings, in the order it was saved.
    fn project_string_list(&self, project_id: u32, column: &'static str) -> Result<Vec<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let json: String = db.query_row(
            &format!("SELECT {column} FROM projects WHERE id = ?1"),
            [project_id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
    }

    /// Replaces a Project column holding a JSON array of strings.
    fn set_project_string_list(
        &self,
        project_id: u32,
        column: &'static str,
        values: Vec<String>,
    ) -> Result<()> {
        let json = serde_json::to_string(&values).expect("project list serializes");
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let changed = db.execute(
            &format!("UPDATE projects SET {column} = ?2 WHERE id = ?1"),
            rusqlite::params![project_id, json],
        )?;
        if changed == 0 {
            return Err(crate::Error::Db(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Computes the Thread-scoped Dossier from the Transcript, Checkpoints and the Project's
    /// Verification commands and sensitive paths. It runs nothing in the checkout and stores
    /// nothing.
    pub fn verification_dossier(&self, thread_id: u32) -> Result<VerificationDossier> {
        Ok(self.computed_dossier(thread_id)?.1)
    }

    /// The Dossier of the Thread's whole branch: the Thread-scoped evidence plus the commits no
    /// Turn produced and, when GitHub reports one, the pull request's checks.
    pub fn branch_dossier(&self, thread_id: u32) -> Result<VerificationDossier> {
        let (root, mut dossier) = self.computed_dossier(thread_id)?;
        if let Some(history) = self.branch_commits(thread_id, &root)? {
            dossier.base_branch = Some(history.base);
            dossier.coverage_known = history.comparable;
            dossier.uncovered_commits = history.uncovered;
        }
        if let Ok(status) = git::status(&root)
            && let Some(branch) = status.branch
            && let Ok(found) = crate::github::branch_pull_request_checks(&self.gh, &root, &branch)
        {
            dossier.pull_request_known = true;
            dossier.pull_request = found.map(|pull_request| DossierPullRequest {
                number: pull_request.number,
                url: pull_request.url,
                checks: pull_request.checks,
            });
        }
        Ok(dossier)
    }

    fn computed_dossier(&self, thread_id: u32) -> Result<(PathBuf, VerificationDossier)> {
        let snapshot = self.storage.get_snapshot(thread_id, u32::MAX)?;
        let project_id = snapshot.thread.project_id;
        let root = std::path::PathBuf::from(self.checkout_path(project_id, Some(thread_id))?);
        let commands = self.project_verification_commands(project_id)?;
        let sensitive_paths = self.project_sensitive_paths(project_id)?;
        let issue = self.stored_issue(thread_id)?;
        let mut dossier = compute(
            &root,
            thread_id,
            &snapshot.turns,
            &commands,
            &sensitive_paths,
            issue,
        );
        dossier.supervision = supervision(&snapshot.turns);
        Ok((root, dossier))
    }

    /// The issue a Thread was started from, as it was stored when the Thread was dispatched.
    fn stored_issue(&self, thread_id: u32) -> Result<Option<DossierIssue>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.query_row(
            "SELECT issue_number, issue_title, issue_url FROM threads WHERE id = ?1",
            [thread_id],
            |r| {
                let number: Option<u32> = r.get(0)?;
                let title: Option<String> = r.get(1)?;
                // Only a web page is a link the Dossier may offer.
                let url: Option<String> = r
                    .get::<_, Option<String>>(2)?
                    .filter(|url| url.starts_with("https://"));
                Ok(number.map(|number| DossierIssue { number, title, url }))
            },
        )
        .map_err(Into::into)
    }

    /// Commits since the merge-base with the base branch that no Turn recorded as its own. A
    /// Turn owns the commits that became reachable from HEAD while it ran; a commit outside
    /// every Turn is never presented as covered. Turns stored before HEAD was recorded fall back
    /// to their start and end times.
    fn branch_commits(&self, thread_id: u32, root: &Path) -> Result<Option<BranchCommits>> {
        let Some(history) = git_diff::branch_commits(root)? else {
            return Ok(None);
        };
        let turns: Vec<TurnHeads> = {
            let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
            let mut stmt = db.prepare(
                "SELECT head_before, head_after, CAST(strftime('%s', started_at) AS INTEGER), \
                 CAST(COALESCE(strftime('%s', completed_at), strftime('%s', 'now')) AS INTEGER) \
                 FROM turns WHERE thread_id = ?1 ORDER BY id ASC",
            )?;
            let rows = stmt.query_map([thread_id], |r| {
                Ok(TurnHeads {
                    before: r.get(0)?,
                    after: r.get(1)?,
                    started_at: r.get(2)?,
                    ended_at: r.get(3)?,
                })
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut covered = HashSet::new();
        for turn in turns {
            if let Some(before) = turn.before {
                // A Turn still running has no end HEAD yet: HEAD now is as far as it has got.
                let after = turn.after.as_deref().unwrap_or("HEAD");
                if let Ok(log) = git::run(root, &["rev-list", &format!("{before}..{after}")]) {
                    covered.extend(
                        log.lines()
                            .filter(|line| !line.is_empty())
                            .map(str::to_string),
                    );
                }
                continue;
            }
            covered.extend(
                history
                    .commits
                    .iter()
                    .filter(|commit| {
                        commit.committed_at >= turn.started_at
                            && commit.committed_at <= turn.ended_at
                    })
                    .map(|commit| commit.sha.clone()),
            );
        }
        let uncovered = history
            .commits
            .into_iter()
            .filter(|commit| !covered.contains(&commit.sha))
            .map(|commit| BranchCommit {
                sha: commit.sha,
                subject: commit.subject,
            })
            .collect();
        Ok(Some(BranchCommits {
            base: history.base,
            comparable: history.comparable,
            uncovered,
        }))
    }
}

struct TurnHeads {
    before: Option<String>,
    after: Option<String>,
    started_at: i64,
    ended_at: i64,
}

struct BranchCommits {
    base: String,
    comparable: bool,
    uncovered: Vec<BranchCommit>,
}

fn supervision(turns: &[TurnSnapshot]) -> Supervision {
    let mut supervision = Supervision::default();
    let mut modes: HashMap<Option<PermissionMode>, u32> = HashMap::new();
    for turn in turns {
        for approval in &turn.approvals {
            match approval.decision {
                Some(crate::ApprovalDecision::Allow) => supervision.approvals_granted += 1,
                Some(crate::ApprovalDecision::Deny) => supervision.approvals_denied += 1,
                None => {}
            }
        }
        *modes.entry(turn.permission_mode).or_default() += 1;
    }
    let order = |mode: Option<PermissionMode>| match mode {
        Some(PermissionMode::Ask) => 0,
        Some(PermissionMode::AutoEdit) => 1,
        Some(PermissionMode::FullAccess) => 2,
        None => 3,
    };
    let mut modes: Vec<PermissionModeUse> = modes
        .into_iter()
        .map(|(mode, turns)| PermissionModeUse { mode, turns })
        .collect();
    modes.sort_by_key(|entry| order(entry.mode));
    supervision.permission_modes = modes;
    supervision
}

fn compute(
    root: &Path,
    thread_id: u32,
    turns: &[TurnSnapshot],
    project_commands: &[String],
    project_sensitive_paths: &[String],
    issue: Option<DossierIssue>,
) -> VerificationDossier {
    // A Provider reports absolute paths as it sees them; compare them with the checkout as Git
    // spells it, too.
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let declared: Vec<DeclaredCommand> = project_commands
        .iter()
        .filter_map(|command| {
            let tokens = command_tokens(command);
            if tokens.is_empty() {
                return None;
            }
            let kind = classify(tokens.clone())
                .map(|signature| signature.kind)
                .unwrap_or(VerificationKind::Other);
            Some(DeclaredCommand {
                tokens,
                command: command.trim().to_string(),
                kind,
            })
        })
        .collect();

    let mut latest: HashMap<String, Run> = HashMap::new();
    let mut facts: HashMap<u32, TurnFacts> = HashMap::new();
    for turn in turns {
        let mut named = HashSet::new();
        let mut last_file_change = None;
        for item in &turn.items {
            if item.kind == ItemKind::FileChange {
                if let Some(path) = named_path(item, &root) {
                    named.insert(path);
                }
                last_file_change = Some(item.item_index);
            }
            let Some(line) = item.command.line.as_deref() else {
                continue;
            };
            let Some(signature) = signature(line, &declared) else {
                continue;
            };
            latest.insert(
                signature.command,
                Run {
                    kind: signature.kind,
                    turn_index: turn.turn_index,
                    item_index: item.item_index,
                    outcome: item.command.outcome,
                    exit_code: item.command.exit_code,
                },
            );
        }
        facts.insert(
            turn.turn_index,
            TurnFacts {
                named,
                last_file_change,
            },
        );
    }

    // One Git diff per Turn, shared by freshness and the risk signals.
    let turn_diffs: HashMap<u32, Vec<DiffFile>> = turns
        .iter()
        .filter_map(|turn| {
            checkpoint::turn_diff(&root, thread_id, turn.turn_index)
                .ok()
                .map(|diff| (turn.turn_index, diff.files))
        })
        .collect();

    let successful_turns: HashSet<u32> = latest
        .values()
        .filter(|run| run.outcome == CommandOutcome::Succeeded)
        .map(|run| run.turn_index)
        .collect();
    let mut tree_matches = HashMap::new();
    let mut unattributed = HashSet::new();
    for &turn_index in &successful_turns {
        tree_matches.insert(
            turn_index,
            checkpoint::working_tree_matches_end(&root, thread_id, turn_index),
        );
        let Some(turn_facts) = facts.get(&turn_index) else {
            continue;
        };
        let any = turn_diffs
            .get(&turn_index)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .any(|file| {
                let named = |path: &str| turn_facts.named.contains(path);
                !named(&file.path) && !file.old_path.as_deref().is_some_and(named)
            });
        if any {
            unattributed.insert(turn_index);
        }
    }

    let mut commands = Vec::new();
    for (command, run) in latest {
        let state = state_of(&run, &facts, &tree_matches, &unattributed);
        commands.push(VerificationCommand {
            command,
            kind: run.kind,
            state,
            turn_index: Some(run.turn_index),
            outcome: Some(run.outcome),
            exit_code: run.exit_code,
        });
    }
    let ran: HashSet<String> = commands
        .iter()
        .map(|command| command.command.clone())
        .collect();
    for project in &declared {
        if !ran.contains(project.command.as_str()) {
            commands.push(VerificationCommand {
                command: project.command.clone(),
                kind: project.kind,
                state: VerificationState::NeverRun,
                turn_index: None,
                outcome: None,
                exit_code: None,
            });
        }
    }
    commands.sort_by(|a, b| {
        state_rank(a.state)
            .cmp(&state_rank(b.state))
            .then_with(|| a.command.cmp(&b.command))
            .then_with(|| kind_rank(a.kind).cmp(&kind_rank(b.kind)))
    });
    let turn_indexes: Vec<u32> = turns.iter().map(|turn| turn.turn_index).collect();
    let thread_diff = checkpoint::thread_diff(&root, thread_id, &turn_indexes)
        .ok()
        .flatten();
    let changed = changed_files(thread_diff.as_ref());
    let signals = risk_signals(&changed, &commands, project_sensitive_paths);
    let prompts = turns
        .iter()
        .map(|turn| turn.prompt.clone())
        .filter(|prompt| !prompt.trim().is_empty())
        .collect();
    VerificationDossier {
        commands,
        signals,
        intent: DossierIntent { issue, prompts },
        claim: closing_claim(turns),
        ..VerificationDossier::default()
    }
}

/// The agent's closing message: the last top-level message of the last Turn. An earlier Turn's
/// message is not the claim, and neither is a message nested under a Subagent.
fn closing_claim(turns: &[TurnSnapshot]) -> Option<AgentClaim> {
    let turn = turns.last()?;
    turn.final_agent_message()
        .filter(|item| !item.content.trim().is_empty())
        .map(|item| AgentClaim {
            turn_index: turn.turn_index,
            text: item.content.trim().to_string(),
        })
}

/// The files the Thread changed as a whole, with the lines each file's net change touches.
fn changed_files(diff: Option<&Diff>) -> BTreeMap<String, u32> {
    diff.map(|diff| {
        diff.files
            .iter()
            .map(|file| (file.path.clone(), file.added + file.removed))
            .collect()
    })
    .unwrap_or_default()
}

fn risk_signals(
    changed: &BTreeMap<String, u32>,
    commands: &[VerificationCommand],
    project_sensitive_paths: &[String],
) -> Vec<RiskSignal> {
    let mut signals = Vec::new();
    let mut covered = HashSet::new();
    let mut covers_all = false;
    for command in commands
        .iter()
        .filter(|command| command.turn_index.is_some())
    {
        match command_coverage(&command.command) {
            CommandCoverage::Languages(languages) => covered.extend(languages),
            CommandCoverage::EveryLanguage => covers_all = true,
        }
    }
    let mut languages: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for path in changed.keys() {
        if let Some(language) = language_of(path) {
            languages.entry(language).or_default().push(path.clone());
        }
    }
    for (language, files) in languages {
        if covers_all || covered.contains(language) {
            continue;
        }
        signals.push(RiskSignal {
            kind: RiskSignalKind::UncheckedLanguage,
            explanation: format!("{language} changed with no Verification command."),
            files,
            language: Some(language.to_string()),
            threshold: None,
        });
    }
    let source: Vec<String> = changed
        .keys()
        .filter(|path| is_source(path) && !is_test_path(path))
        .cloned()
        .collect();
    let has_test_change = changed.keys().any(|path| is_test_path(path));
    if !source.is_empty() && !has_test_change {
        signals.push(RiskSignal {
            kind: RiskSignalKind::SourceWithoutTests,
            explanation: "Source changed with no test change.".to_string(),
            files: source,
            language: None,
            threshold: None,
        });
    }
    for (explanation, files) in sensitive_changes(changed, project_sensitive_paths) {
        signals.push(RiskSignal {
            kind: RiskSignalKind::SensitivePath,
            explanation: explanation.to_string(),
            files,
            language: None,
            threshold: None,
        });
    }
    let lines: u32 = changed.values().sum();
    if lines > LARGE_DIFF_LINES {
        signals.push(RiskSignal {
            kind: RiskSignalKind::LargeDiff,
            explanation: format!(
                "The diff changes {lines} lines, over the {LARGE_DIFF_LINES}-line threshold."
            ),
            files: changed.keys().cloned().collect(),
            language: None,
            threshold: Some(LARGE_DIFF_LINES),
        });
    }
    signals.sort_by(|a, b| {
        signal_rank(a.kind)
            .cmp(&signal_rank(b.kind))
            .then_with(|| a.explanation.cmp(&b.explanation))
            .then_with(|| a.files.cmp(&b.files))
    });
    signals
}

fn signal_rank(kind: RiskSignalKind) -> u8 {
    match kind {
        RiskSignalKind::UncheckedLanguage => 0,
        RiskSignalKind::SourceWithoutTests => 1,
        RiskSignalKind::SensitivePath => 2,
        RiskSignalKind::LargeDiff => 3,
    }
}

/// The sensitive groups the change touches, each with its files. A file belongs to the first
/// group that matches it, so the groups never repeat a path.
fn sensitive_changes(
    changed: &BTreeMap<String, u32>,
    project_sensitive_paths: &[String],
) -> Vec<(&'static str, Vec<String>)> {
    let mut unmatched: std::collections::BTreeSet<&str> =
        changed.keys().map(String::as_str).collect();
    let mut groups = Vec::new();
    for (patterns, explanation) in [
        (CI_SENSITIVE, "Touches CI configuration."),
        (DEPENDENCY_SENSITIVE, "Touches a dependency manifest."),
        (MIGRATION_SENSITIVE, "Touches database migrations."),
    ] {
        let Some(matcher) = gitignore(patterns.iter().copied()) else {
            continue;
        };
        let files: Vec<String> = unmatched
            .iter()
            .filter(|path| matcher.matches(path))
            .map(|path| path.to_string())
            .collect();
        for file in &files {
            unmatched.remove(file.as_str());
        }
        if !files.is_empty() {
            groups.push((explanation, files));
        }
    }
    if !project_sensitive_paths.is_empty() {
        let Some(matcher) = gitignore(project_sensitive_paths.iter().map(String::as_str)) else {
            return groups;
        };
        let files: Vec<String> = unmatched
            .into_iter()
            .filter(|path| matcher.matches(path))
            .map(str::to_string)
            .collect();
        if !files.is_empty() {
            groups.push(("Touches a configured sensitive path.", files));
        }
    }
    groups
}

struct SensitiveMatcher(ignore::gitignore::Gitignore);

impl SensitiveMatcher {
    /// Gitignore semantics: a bare name matches at any depth, a pattern with a slash is relative
    /// to the checkout, and a directory pattern matches the files under it.
    fn matches(&self, path: &str) -> bool {
        self.0
            .matched_path_or_any_parents(Path::new(path), false)
            .is_ignore()
    }
}

fn gitignore<'a>(patterns: impl IntoIterator<Item = &'a str>) -> Option<SensitiveMatcher> {
    let mut builder = ignore::gitignore::GitignoreBuilder::new("");
    for pattern in patterns {
        let pattern = pattern.trim();
        if !pattern.is_empty() {
            // An invalid pattern is skipped rather than making the whole Dossier fail.
            let _ = builder.add_line(None, pattern);
        }
    }
    builder.build().ok().map(SensitiveMatcher)
}

enum CommandCoverage {
    Languages(Vec<&'static str>),
    /// The command crosses ecosystems (a Makefile, a Bazel target or a Project's own script), so
    /// Oxide cannot claim that any language stayed uncovered.
    EveryLanguage,
}

/// The languages of the files a language-aware command checks.
fn command_coverage(command: &str) -> CommandCoverage {
    let tokens = command_tokens(command);
    let Some(program) = tokens.first().map(|token| program_name(token)) else {
        return CommandCoverage::EveryLanguage;
    };
    let languages: &'static [&'static str] = match program {
        "cargo" | "rustc" | "rustfmt" | "clippy-driver" => &["Rust"],
        "npm" | "pnpm" | "yarn" | "bun" | "tsc" | "vue-tsc" | "svelte-check" | "jest"
        | "vitest" | "mocha" | "ava" | "tap" | "eslint" | "oxlint" | "biome" | "prettier"
        | "deno" | "node" => &["JavaScript", "TypeScript", "Vue", "Svelte"],
        "pytest" | "mypy" | "pyright" | "pyre" | "ruff" | "flake8" | "pylint" | "black"
        | "python" | "python3" => &["Python"],
        "go" | "golangci-lint" => &["Go"],
        "mvn" | "mvnw" | "gradle" | "gradlew" => &["Java", "Kotlin"],
        "java" | "javac" | "junit" => &["Java"],
        "kotlinc" | "ktlint" => &["Kotlin"],
        "ctest" | "cmake" | "ninja" | "clang" | "clang++" | "gcc" | "g++" | "clang-tidy"
        | "cppcheck" => &["C", "C++"],
        "swift" | "xcodebuild" => &["Swift"],
        "rake" | "rspec" | "rubocop" => &["Ruby"],
        "php" | "phpunit" | "phpstan" | "psalm" => &["PHP"],
        "dotnet" | "msbuild" => &["C#"],
        "flutter" | "dart" => &["Dart"],
        "mix" => &["Elixir"],
        "shellcheck" => &["Shell"],
        "lua" | "luac" => &["Lua"],
        "scala" | "sbt" => &["Scala"],
        "terraform" => &["Terraform"],
        _ => return CommandCoverage::EveryLanguage,
    };
    CommandCoverage::Languages(languages.to_vec())
}

/// Whether a path is source a reviewer reads, not documentation, data or a generated file.
fn is_source(path: &str) -> bool {
    language_of(path).is_some()
}

/// Whether a path names test code or test data. A test change is what proves a source change.
fn is_test_path(path: &str) -> bool {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    let segments: Vec<&str> = path.split('/').collect();
    let in_test_directory = segments.iter().rev().skip(1).any(|segment| {
        matches!(
            *segment,
            "test" | "tests" | "__tests__" | "spec" | "specs" | "testdata" | "fixtures"
        )
    });
    let name = segments.last().copied().unwrap_or_default();
    let test_file = name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with(".snap")
        || name.starts_with("test_")
        || name.ends_with("_test.py")
        || name.ends_with("_test.go")
        || name.ends_with("_tests.rs")
        || name.ends_with("_test.rs")
        || name.ends_with("_spec.rb")
        || name.ends_with("test.java")
        || name.ends_with("tests.java")
        || name.ends_with("test.kt")
        || name.ends_with("test.cs");
    test_file || (in_test_directory && is_test_artifact(&path))
}

/// Whether a path in a test directory is test code or a snapshot, rather than documentation or a
/// fixture that happens to sit under a folder called `spec` (say, `docs/spec/api.md`).
fn is_test_artifact(path: &str) -> bool {
    language_of(path).is_some() || path.ends_with(".snap")
}

/// The language a source file is written in, as a display name. Test, documentation and data
/// files have none.
fn language_of(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    let language = match extension.as_str() {
        "rs" => "Rust",
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "py" | "pyi" => "Python",
        "go" => "Go",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "rb" => "Ruby",
        "php" => "PHP",
        "cs" => "C#",
        "c" | "h" => "C",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" => "C++",
        "dart" => "Dart",
        "ex" | "exs" => "Elixir",
        "sh" | "bash" | "zsh" => "Shell",
        "lua" => "Lua",
        "scala" => "Scala",
        "sql" => "SQL",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "tf" => "Terraform",
        _ => return None,
    };
    Some(language)
}

fn state_of(
    run: &Run,
    facts: &HashMap<u32, TurnFacts>,
    tree_matches: &HashMap<u32, Option<bool>>,
    unattributed: &HashSet<u32>,
) -> VerificationState {
    match run.outcome {
        CommandOutcome::Failed => VerificationState::Failed,
        CommandOutcome::Unknown => VerificationState::Unknown,
        CommandOutcome::Succeeded => {
            // A FileChange Item after the command is an edit the agent made afterwards.
            let turn_facts = facts.get(&run.turn_index);
            if turn_facts
                .and_then(|facts| facts.last_file_change)
                .is_some_and(|index| index > run.item_index)
            {
                return VerificationState::Stale;
            }
            // Across Turns and human edits, only an unchanged tree keeps the result fresh.
            match tree_matches.get(&run.turn_index) {
                Some(Some(true)) => {}
                Some(Some(false)) => return VerificationState::Stale,
                // No end Checkpoint, or the working tree could not be compared: never invent it.
                _ => return VerificationState::Unknown,
            }
            if unattributed.contains(&run.turn_index) {
                return VerificationState::Unknown;
            }
            VerificationState::Fresh
        }
    }
}

fn state_rank(state: VerificationState) -> u8 {
    match state {
        VerificationState::Failed => 0,
        VerificationState::Stale => 1,
        VerificationState::Unknown => 2,
        VerificationState::NeverRun => 3,
        VerificationState::Fresh => 4,
    }
}

fn kind_rank(kind: VerificationKind) -> u8 {
    match kind {
        VerificationKind::Test => 0,
        VerificationKind::Lint => 1,
        VerificationKind::TypeCheck => 2,
        VerificationKind::Build => 3,
        VerificationKind::Other => 4,
    }
}

struct Run {
    kind: VerificationKind,
    turn_index: u32,
    item_index: u32,
    outcome: CommandOutcome,
    exit_code: Option<i32>,
}

#[derive(Default)]
struct TurnFacts {
    /// Paths the Turn's FileChange Items name.
    named: HashSet<String>,
    /// The highest Item index that is a FileChange.
    last_file_change: Option<u32>,
}

/// The path a FileChange Item names. By convention it is the content's headline, the first line.
fn named_path(item: &ItemSnapshot, root: &Path) -> Option<String> {
    let headline = item.content.lines().find(|line| !line.trim().is_empty())?;
    let path = headline.trim().replace('\\', "/");
    if path.is_empty() {
        return None;
    }
    let path = Path::new(&path);
    let path = if path.is_absolute() {
        canonical_path(path)
    } else {
        path.to_path_buf()
    };
    let relative = path.strip_prefix(root).unwrap_or(&path);
    Some(
        relative
            .to_string_lossy()
            .trim_start_matches("./")
            .to_string(),
    )
}

/// An absolute path as Git spells it. A deleted file still resolves through its parent.
fn canonical_path(path: &Path) -> std::path::PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(parent) => parent.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

struct Signature {
    command: String,
    kind: VerificationKind,
}

fn signature(line: &str, declared: &[DeclaredCommand]) -> Option<Signature> {
    for segment in shell_segments(line) {
        if let Some(signature) = declared_signature(segment, declared) {
            return Some(signature);
        }
        if let Some(signature) = classify(command_tokens(segment)) {
            return Some(signature);
        }
    }
    None
}

struct DeclaredCommand {
    tokens: Vec<String>,
    command: String,
    kind: VerificationKind,
}

fn declared_signature(segment: &str, declared: &[DeclaredCommand]) -> Option<Signature> {
    let tokens = command_tokens(segment);
    declared
        .iter()
        .find(|candidate| starts_with(&tokens, &candidate.tokens))
        .map(|candidate| Signature {
            command: candidate.command.clone(),
            kind: candidate.kind,
        })
}

fn starts_with(tokens: &[String], prefix: &[String]) -> bool {
    prefix.len() <= tokens.len() && tokens[..prefix.len()] == *prefix
}

/// The shell's command segments, so `cd web && npm test` finds `npm test` and a pipe or a
/// background operator does not hide it. Quotes keep their contents together.
fn shell_segments(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        match quote {
            Some(q) => {
                if byte == b'\\' && q == b'"' {
                    i += 1;
                } else if byte == q {
                    quote = None;
                }
            }
            None => {
                if byte == b'\'' || byte == b'"' {
                    quote = Some(byte);
                } else if byte == b'\n' || byte == b';' || byte == b'&' || byte == b'|' {
                    segments.push(&line[start..i]);
                    if i + 1 < bytes.len() && bytes[i + 1] == byte && (byte == b'&' || byte == b'|')
                    {
                        i += 1;
                    }
                    start = i + 1;
                }
            }
        }
        i += 1;
    }
    segments.push(&line[start..]);
    segments
}

/// A segment's words, with the wrappers that merely launch a command stripped: env assignments,
/// `sudo`, `npx`, `python -m`, `uv run`, `bundle exec` and the like.
fn command_tokens(segment: &str) -> Vec<String> {
    let mut tokens: Vec<String> = segment
        .split_whitespace()
        .map(|token| token.trim_matches(|c| c == '\'' || c == '"'))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect();
    loop {
        while tokens.first().is_some_and(|token| is_env_assignment(token)) {
            tokens.remove(0);
        }
        let Some(first) = tokens.first() else {
            break;
        };
        let program = program_name(first);
        let second = tokens.get(1).map(String::as_str);
        if matches!(
            program,
            "sudo" | "env" | "time" | "command" | "nice" | "nohup" | "unbuffer"
        ) || (matches!(program, "npx" | "pnpx" | "bunx" | "uvx") && tokens.len() > 1)
        {
            tokens.remove(0);
        } else if (matches!(program, "uv" | "poetry" | "pipenv") && second == Some("run"))
            || (program == "bundle" && second == Some("exec"))
            || (program == "pnpm" && second == Some("exec"))
            || (program == "yarn" && second == Some("dlx"))
            || (program == "bun" && second == Some("x"))
        {
            tokens.drain(0..2);
        } else if program == "corepack" && tokens.get(1).is_some_and(|t| t == "pnpm") {
            tokens.remove(0);
        } else if program_is_python(program) && second == Some("-m") && tokens.len() > 2 {
            tokens.drain(0..2);
        } else {
            break;
        }
    }
    tokens
}

fn is_env_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The executable's name without a directory or `./`.
fn program_name(token: &str) -> &str {
    let name = token.rsplit('/').next().unwrap_or(token);
    name.trim_start_matches("./")
}

fn program_is_python(program: &str) -> bool {
    program == "python" || program.starts_with("python3") || program == "py"
}

fn classify(tokens: Vec<String>) -> Option<Signature> {
    let first = tokens.first()?;
    let program = program_name(first);
    let rest = &tokens[1..];
    let signature = |command: &str, kind: VerificationKind| {
        Some(Signature {
            command: command.to_string(),
            kind,
        })
    };
    let when = |condition: bool, command: &str, kind: VerificationKind| {
        condition.then(|| signature(command, kind)).flatten()
    };
    let first = rest.first().map(String::as_str);
    let has = |needle: &str| rest.iter().any(|token| token == needle);

    match program {
        "cargo" => {
            let rest = rest
                .iter()
                .skip_while(|token| token.starts_with('+'))
                .map(String::as_str)
                .collect::<Vec<_>>();
            match rest.first().copied() {
                Some("test") => signature("cargo test", VerificationKind::Test),
                Some("clippy") => signature("cargo clippy", VerificationKind::Lint),
                Some("check") => signature("cargo check", VerificationKind::TypeCheck),
                Some("build") => signature("cargo build", VerificationKind::Build),
                Some("nextest") if rest.get(1) == Some(&"run") => {
                    signature("cargo nextest run", VerificationKind::Test)
                }
                _ => None,
            }
        }
        "npm" | "pnpm" | "yarn" | "bun" => js_signature(program, rest),
        "tsc" | "vue-tsc" | "svelte-check" | "mypy" | "pyright" | "pyre" | "flow" => {
            signature(program, VerificationKind::TypeCheck)
        }
        "jest" | "vitest" | "mocha" | "ava" | "tap" | "pytest" | "phpunit" | "rspec" | "ctest"
        | "unittest" => signature(program, VerificationKind::Test),
        "eslint" | "oxlint" | "flake8" | "pylint" | "rubocop" | "shellcheck" | "golangci-lint"
        | "black" => signature(program, VerificationKind::Lint),
        "biome" => when(
            matches!(first, Some("check" | "lint" | "format")),
            "biome check",
            VerificationKind::Lint,
        ),
        "ruff" => when(
            matches!(first, Some("check" | "format" | "lint") | None),
            "ruff",
            VerificationKind::Lint,
        ),
        "prettier" => when(has("--check"), "prettier --check", VerificationKind::Lint),
        "rustfmt" => signature("rustfmt", VerificationKind::Lint),
        "go" => match first {
            Some("test") => signature("go test", VerificationKind::Test),
            Some("vet") => signature("go vet", VerificationKind::TypeCheck),
            Some("build") => signature("go build", VerificationKind::Build),
            _ => None,
        },
        "mvn" | "mvnw" => {
            if has("test") || has("verify") {
                signature("mvn test", VerificationKind::Test)
            } else if has("compile") || has("package") {
                signature("mvn package", VerificationKind::Build)
            } else {
                None
            }
        }
        "gradle" | "gradlew" => {
            if has("test") || has("check") {
                signature("gradle test", VerificationKind::Test)
            } else if has("build") {
                signature("gradle build", VerificationKind::Build)
            } else {
                None
            }
        }
        "dotnet" => match first {
            Some("test") => signature("dotnet test", VerificationKind::Test),
            Some("build") => signature("dotnet build", VerificationKind::Build),
            _ => None,
        },
        "make" | "just" | "task" | "mask" => {
            let target = first?;
            let kind = match target {
                "test" | "tests" => VerificationKind::Test,
                "lint" => VerificationKind::Lint,
                "check" | "typecheck" | "type-check" => VerificationKind::TypeCheck,
                "build" => VerificationKind::Build,
                other => script_kind(other)?,
            };
            signature(&format!("{program} {target}"), kind)
        }
        "rake" => when(first == Some("test"), "rake test", VerificationKind::Test),
        "swift" => match first {
            Some("test") => signature("swift test", VerificationKind::Test),
            Some("build") => signature("swift build", VerificationKind::Build),
            _ => None,
        },
        "flutter" | "dart" => match first {
            Some("test") => signature(&format!("{program} test"), VerificationKind::Test),
            Some("analyze") => signature(&format!("{program} analyze"), VerificationKind::Lint),
            _ => None,
        },
        "mix" => when(first == Some("test"), "mix test", VerificationKind::Test),
        "bazel" | "bazelisk" => match first {
            Some("test") => signature("bazel test", VerificationKind::Test),
            Some("build") => signature("bazel build", VerificationKind::Build),
            _ => None,
        },
        "deno" => match first {
            Some("test") => signature("deno test", VerificationKind::Test),
            Some("check") => signature("deno check", VerificationKind::TypeCheck),
            Some("lint") => signature("deno lint", VerificationKind::Lint),
            _ => None,
        },
        "node" => when(
            first == Some("--test"),
            "node --test",
            VerificationKind::Test,
        ),
        _ => None,
    }
}

fn js_signature(program: &str, rest: &[String]) -> Option<Signature> {
    let rest: Vec<&str> = rest
        .iter()
        .map(String::as_str)
        .skip_while(|token| token.starts_with('-'))
        .collect();
    let first = *rest.first()?;
    let run = matches!(first, "run" | "run-script");
    let script = if run { *rest.get(1)? } else { first };
    let kind = script_kind(script)?;
    let command = if run {
        format!("{program} run {script}")
    } else {
        format!("{program} {script}")
    };
    Some(Signature { command, kind })
}

fn script_kind(script: &str) -> Option<VerificationKind> {
    let script = script.to_ascii_lowercase();
    if script == "test" || script.starts_with("test:") || script.starts_with("test-") {
        Some(VerificationKind::Test)
    } else if script.contains("lint") {
        Some(VerificationKind::Lint)
    } else if script.contains("typecheck")
        || script.contains("type-check")
        || script == "types"
        || script == "check"
    {
        Some(VerificationKind::TypeCheck)
    } else if script == "build" || script.starts_with("build:") {
        Some(VerificationKind::Build)
    } else {
        None
    }
}
