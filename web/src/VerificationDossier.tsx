import { useEffect, useState } from "react";
import { commands, type VerificationDossier as Dossier, type VerificationKind, type VerificationState } from "./bindings";
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

interface VerificationDossierProps {
  projectId: number;
  threadId: number;
  /** Changes whenever a Turn does, so the evidence is recomputed. */
  refreshKey: string;
}

/** Which Verification commands ran in this Thread, and whether each result still applies. */
export function VerificationDossier({ projectId, threadId, refreshKey }: VerificationDossierProps) {
  const [reload, setReload] = useState(0);
  const query = useQuery(
    `p${projectId}:dossier:${threadId}`,
    async (): Promise<QueryResult<Dossier>> => await commands.verificationDossier(threadId),
    `${refreshKey}#${reload}`,
  );
  const entries = query.state === "ready" ? (query.data?.commands ?? []) : [];
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
      <VerificationCommandsEditor projectId={projectId} onSaved={() => setReload((n) => n + 1)} />
    </section>
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
