//! The Verification Dossier: which commands count as checks for a Thread, and whether the result
//! of each still applies to the files as they are now. Computed every time from the Transcript,
//! the Checkpoints and the Project's Verification commands; never persisted, never run, no LLM.
//!
//! A command is fresh only if it succeeded after the last known change. Within a Turn the order of
//! Items says whether a FileChange came after the command. Across Turns and human edits, the tree
//! at the end of the command's Turn must match the working tree. A Turn whose Checkpoint diff
//! includes files that no FileChange Item names (a shell edit, say) makes freshness unknown rather
//! than fresh, because Oxide cannot tell when those files changed.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::thread::{ItemSnapshot, TurnSnapshot};
use crate::{CommandOutcome, Core, ItemKind, Result, checkpoint};

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

/// The Verification section of the Diff Surface for one Thread.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationDossier {
    /// Risk first: failed, stale, unknown, never run, then fresh. Ties by command.
    pub commands: Vec<VerificationCommand>,
}

impl Core {
    /// The Project's own Verification commands, in the order they were saved.
    pub fn project_verification_commands(&self, project_id: u32) -> Result<Vec<String>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let json: String = db.query_row(
            "SELECT verification_commands FROM projects WHERE id = ?1",
            [project_id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
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
        let json = serde_json::to_string(&commands).expect("Verification commands serialize");
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let changed = db.execute(
            "UPDATE projects SET verification_commands = ?2 WHERE id = ?1",
            rusqlite::params![project_id, json],
        )?;
        if changed == 0 {
            return Err(crate::Error::Db(rusqlite::Error::QueryReturnedNoRows));
        }
        Ok(())
    }

    /// Computes the Dossier from the Thread's Transcript and Checkpoints and the Project's
    /// Verification commands. It runs nothing and stores nothing.
    pub fn verification_dossier(&self, thread_id: u32) -> Result<VerificationDossier> {
        let snapshot = self.storage.get_snapshot(thread_id, u32::MAX)?;
        let project_id = snapshot.thread.project_id;
        let root = std::path::PathBuf::from(self.checkout_path(project_id, Some(thread_id))?);
        let commands = self.project_verification_commands(project_id)?;
        Ok(compute(&root, thread_id, &snapshot.turns, &commands))
    }
}

fn compute(
    root: &Path,
    thread_id: u32,
    turns: &[TurnSnapshot],
    project_commands: &[String],
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
        let changed = checkpoint::turn_diff(&root, thread_id, turn_index)
            .map(|diff| diff.files)
            .unwrap_or_default();
        let any = changed.iter().any(|file| {
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
    VerificationDossier { commands }
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
