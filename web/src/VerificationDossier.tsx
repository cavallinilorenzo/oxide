import { useCallback, useEffect, useState } from "react";
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
  /** Selects the file a signal points at in the Diff. */
  onOpenFile: (path: string) => void;
}

/** Which Verification commands ran, whether each result still applies, and the separate risk signals. */
export function VerificationDossier({ projectId, threadId, refreshKey, onOpenFile }: VerificationDossierProps) {
  const [reload, setReload] = useState(0);
  const query = useQuery(
    `p${projectId}:dossier:${threadId}`,
    async (): Promise<QueryResult<Dossier>> => await commands.verificationDossier(threadId),
    `${refreshKey}#${reload}`,
  );
  const entries = query.state === "ready" ? (query.data?.commands ?? []) : [];
  const signals = query.state === "ready" ? (query.data?.signals ?? []) : [];
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
      {query.state === "ready" && (
        <div className="dossier-signals-block">
          <span className="dossier-title">Risk signals</span>
          {signals.length === 0 ? (
            <p className="dossier-note">No risk signal.</p>
          ) : (
            <ul className="dossier-signals" aria-label="Risk signals">
              {signals.map((signal) => (
                <li
                  key={`${signal.kind}:${signal.explanation}`}
                  className={`dossier-signal dossier-signal-${signal.kind}`}
                  aria-label={`Risk signal: ${signal.explanation}`}
                >
                  <span className="dossier-signal-explanation">{signal.explanation}</span>
                  {signal.files.length > 0 && (
                    <span className="dossier-signal-files">
                      {signal.files.map((path) => (
                        <button
                          key={path}
                          type="button"
                          className="link dossier-signal-file mono"
                          aria-label={`Open ${path} in the Diff`}
                          onClick={() => onOpenFile(path)}
                        >
                          {path}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <VerificationCommandsEditor projectId={projectId} onSaved={() => setReload((n) => n + 1)} />
      <SensitivePathsEditor projectId={projectId} onSaved={() => setReload((n) => n + 1)} />
    </section>
  );
}

type ListResult = { status: "ok"; data: string[] } | { status: "error"; error: { message: string } };
type SaveResult = { status: "ok"; data: null } | { status: "error"; error: { message: string } };

interface ProjectListEditorProps {
  title: string;
  hint: string;
  placeholder: string;
  load: () => Promise<ListResult>;
  save: (values: string[]) => Promise<SaveResult>;
  onSaved: () => void;
}

/** A Project setting that is one value per line, stored by Oxide and never in the repository. */
function ProjectListEditor({ title, hint, placeholder, load, save, onSaved }: ProjectListEditorProps) {
  const [saved, setSaved] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void load()
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
  }, [load]);

  const values = [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];

  const persist = async () => {
    setSaving(true);
    try {
      const result = await save(values);
      if (result.status === "error") return setError(result.error.message);
      setSaved(values);
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
      <summary>
        {title} ({saved.length})
      </summary>
      <p className="hint">{hint}</p>
      <textarea
        aria-label={title}
        rows={3}
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        className="btn"
        disabled={saving || values.join("\n") === saved.join("\n")}
        onClick={() => void persist()}
      >
        Save
      </button>
      {error && <p className="dossier-note error">{error}</p>}
    </details>
  );
}

/** The Project's own Verification commands, one per line. */
function VerificationCommandsEditor({ projectId, onSaved }: { projectId: number; onSaved: () => void }) {
  const load = useCallback(() => commands.getProjectVerificationCommands(projectId), [projectId]);
  const save = useCallback(
    (values: string[]) => commands.setProjectVerificationCommands(projectId, values),
    [projectId],
  );
  return (
    <ProjectListEditor
      title="Project Verification commands"
      hint="Commands that count as checks beside the built-in patterns, one per line. Stored by Oxide, not in the repository."
      placeholder={"pnpm run verify\nmake check"}
      load={load}
      save={save}
      onSaved={onSaved}
    />
  );
}

/** The Project's own sensitive paths. The built-in CI, dependency and migration patterns stay. */
function SensitivePathsEditor({ projectId, onSaved }: { projectId: number; onSaved: () => void }) {
  const load = useCallback(() => commands.getProjectSensitivePaths(projectId), [projectId]);
  const save = useCallback(
    (values: string[]) => commands.setProjectSensitivePaths(projectId, values),
    [projectId],
  );
  return (
    <ProjectListEditor
      title="Project sensitive paths"
      hint="Extra paths to flag, one glob per line. CI, dependency manifests and migrations are flagged already. Stored by Oxide, not in the repository."
      placeholder={"src/billing/**\ninfra/**"}
      load={load}
      save={save}
      onSaved={onSaved}
    />
  );
}
