import { useEffect, useState } from "react";
import {
  commands,
  type PermissionMode,
  type VerificationDossier_Serialize as Dossier,
  type VerificationKind,
  type VerificationState,
} from "./bindings";
import type { PanelScope } from "./diffScope";
import { CHECK_WORD } from "./PullRequestChecks";
import { dedupeChecks } from "./pullRequestReview";
import { useQuery, type QueryResult } from "./queryCache";

const STATE_LABEL: Record<VerificationState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  failed: "Failed",
  neverRun: "Never run",
  unknown: "Unknown",
};

const STATE_CLASS: Record<VerificationState, string> = {
  fresh: "fresh",
  stale: "stale",
  failed: "failed",
  neverRun: "never-run",
  unknown: "unknown",
};

const KIND_LABEL: Record<VerificationKind, string> = {
  test: "Test",
  lint: "Lint",
  typeCheck: "Type check",
  build: "Build",
  other: "Command",
};

const MODE_LABEL: Record<PermissionMode, string> = {
  ask: "Ask",
  "auto-edit": "Auto-edit",
  "full-access": "Full access",
};

interface VerificationDossierProps {
  projectId: number;
  threadId: number;
  /** The Diff scope; the branch-wide sections are evidence about the whole branch. */
  scope: PanelScope;
  /** Changes whenever a Turn does, so the evidence is recomputed. */
  refreshKey: string;
}

/** Which Verification commands ran in this Thread, whether each result still applies, and in
 *  Branch scope what the branch holds beyond the Thread's Turns. */
export function VerificationDossier({ projectId, threadId, scope, refreshKey }: VerificationDossierProps) {
  const [reload, setReload] = useState(0);
  const branchScope = scope === "branch";
  const query = useQuery(
    `p${projectId}:dossier:${threadId}:${branchScope ? "branch" : "thread"}`,
    async (): Promise<QueryResult<Dossier>> =>
      branchScope ? await commands.branchDossier(threadId) : await commands.verificationDossier(threadId),
    `${refreshKey}#${reload}`,
  );
  const dossier = query.state === "ready" ? query.data : null;
  const entries = dossier?.commands ?? [];
  return (
    <section className="dossier" aria-label="Verification dossier">
      <div className="dossier-head">
        <span className="dossier-title">Verification</span>
        {entries.length > 0 && (
          <span className="dossier-count">
            {entries.length} command{entries.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {query.state === "loading" && <p className="dossier-note">Loading evidence…</p>}
      {query.state === "error" && <p className="dossier-note error">{query.message}</p>}
      {query.state === "ready" && entries.length === 0 && (
        <p className="dossier-note">No Verification command has run in this Thread.</p>
      )}
      {entries.length > 0 && (
        <ul className="dossier-checks" aria-label="Verification commands">
          {entries.map((entry) => (
            <li
              key={`${entry.kind}:${entry.command}`}
              className="dossier-check"
              aria-label={`${entry.command}: ${STATE_LABEL[entry.state]}`}
            >
              <span className={`dossier-badge dossier-badge-${STATE_CLASS[entry.state]}`}>
                {STATE_LABEL[entry.state]}
              </span>
              <code className="dossier-command">{entry.command}</code>
              <span className="dossier-kind">{KIND_LABEL[entry.kind]}</span>
              {entry.turnIndex != null && (
                <span className="dossier-meta">Turn {entry.turnIndex + 1}</span>
              )}
              {entry.exitCode != null && <span className="dossier-meta">exit {entry.exitCode}</span>}
            </li>
          ))}
        </ul>
      )}
      {scope === "branch" && dossier !== null && <BranchEvidence dossier={dossier} />}
      <VerificationCommandsEditor projectId={projectId} onSaved={() => setReload((n) => n + 1)} />
    </section>
  );
}

/** What the branch holds beyond this Thread's Turns: uncovered commits, PR checks and supervision. */
function BranchEvidence({ dossier }: { dossier: Dossier }) {
  const uncovered = dossier.uncoveredCommits;
  const pullRequest = dossier.pullRequest;
  const checks = pullRequest === null ? [] : dedupeChecks(pullRequest.checks);
  const supervision = dossier.supervision;
  const modes = supervision.permissionModes
    .map((entry) => `${entry.mode === null ? "Unknown" : MODE_LABEL[entry.mode]} ${entry.turns}`)
    .join(" · ");
  return (
    <div className="dossier-branch" aria-label="Branch evidence">
      {dossier.baseBranch === null ? (
        <p className="dossier-note">No base branch found, so branch coverage is unknown.</p>
      ) : !dossier.coverageKnown ? (
        <p className="dossier-note">
          Branch coverage is unknown: its history shares no base with {dossier.baseBranch}.
        </p>
      ) : uncovered.length > 0 ? (
        <section className="dossier-branch-section" aria-label="Commits not covered">
          <span className="dossier-subtitle">
            Not covered by this Thread ({uncovered.length})
          </span>
          <ul className="dossier-commits">
            {uncovered.map((commit) => (
              <li key={commit.sha}>
                <code>{commit.sha.slice(0, 7)}</code> <span>{commit.subject}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="dossier-note">Every commit on this branch is covered by a Turn.</p>
      )}
      {!dossier.pullRequestKnown ? (
        <p className="dossier-note">Pull request checks are unavailable.</p>
      ) : pullRequest !== null ? (
        <section className="dossier-branch-section" aria-label="Pull request checks">
          <span className="dossier-subtitle">Pull request #{pullRequest.number}</span>
          {checks.length === 0 ? (
            <p className="dossier-note">No checks reported.</p>
          ) : (
            <ul className="dossier-checks">
              {checks.map((check, index) => (
                <li
                  key={`${check.name}:${index}`}
                  className="dossier-check"
                  aria-label={`${check.name}: ${CHECK_WORD[check.state]}`}
                >
                  <span className={`dossier-badge dossier-badge-${check.state}`}>
                    {CHECK_WORD[check.state]}
                  </span>
                  <code className="dossier-command">{check.name}</code>
                  {check.required && <span className="dossier-meta">Required</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <section className="dossier-branch-section" aria-label="Supervision">
        <span className="dossier-subtitle">Supervision</span>
        <span className="dossier-meta">
          Approvals: {supervision.approvalsGranted} granted, {supervision.approvalsDenied} denied
        </span>
        {modes !== "" && <span className="dossier-meta">Permission modes: {modes}</span>}
      </section>
    </div>
  );
}

/** The Project's own Verification commands, one per line. Stored by Oxide, not in the repository. */
function VerificationCommandsEditor({ projectId, onSaved }: { projectId: number; onSaved: () => void }) {
  const [saved, setSaved] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void commands
      .getProjectVerificationCommands(projectId)
      .then((result) => {
        if (!active) return;
        if (result.status === "ok") {
          const values = result.data ?? [];
          setSaved(values);
          setText(values.join("\n"));
        } else setError(result.error.message);
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const commandsInText = [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];

  const save = async () => {
    setSaving(true);
    try {
      const result = await commands.setProjectVerificationCommands(projectId, commandsInText);
      if (result.status === "error") return setError(result.error.message);
      setSaved(commandsInText);
      setError(null);
      onSaved();
    } catch (error: unknown) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="dossier-commands">
      <summary>Project Verification commands ({saved.length})</summary>
      <p className="hint">
        Commands that count as checks beside the built-in patterns, one per line. Stored by Oxide,
        not in the repository.
      </p>
      <textarea
        aria-label="Project Verification commands"
        rows={3}
        spellCheck={false}
        placeholder={"pnpm run verify\nmake check"}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="btn"
        disabled={saving || commandsInText.join("\n") === saved.join("\n")}
        onClick={() => void save()}
      >
        Save
      </button>
      {error && <p className="dossier-note error">{error}</p>}
    </details>
  );
}
