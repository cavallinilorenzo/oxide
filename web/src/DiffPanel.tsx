import { useEffect, useState } from "react";
import { commands, type Diff, type DiffFile } from "./bindings";
import { matchDiffFile } from "./diffOpen";
import { showsConcurrencyNote, type PanelScope } from "./diffScope";

interface DiffPanelProps {
  projectId: number;
  /** The selected Thread: the Turn scope diffs its latest Turn. */
  threadId: number | null;
  /** Board Threads work in their own worktree, so nothing else edits it. */
  board: boolean;
  scope: PanelScope;
  onScopeChange: (scope: PanelScope) => void;
  /** A file hint from the chat to scroll to and highlight. */
  focus: string | null;
  /** Changes whenever a Thread's status does, so the diff stays current. */
  refreshKey: string;
}

const SCOPES: { scope: PanelScope; label: string }[] = [
  { scope: "turn", label: "Turn" },
  { scope: "uncommitted", label: "Uncommitted" },
  { scope: "branch", label: "Branch" },
];

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; diff: Diff };

/** Git's view of a Project's changes. State belongs to one Project, so a different one, or another scope, remounts it. */
export function DiffPanel(props: DiffPanelProps) {
  return <DiffBody key={`${props.projectId}:${props.scope}`} {...props} />;
}

function DiffBody({ projectId, threadId, board, scope, onScopeChange, focus, refreshKey }: DiffPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (scope === "turn" && threadId === null) {
        setLoaded({ state: "ready", diff: { base: null, files: [] } });
        return;
      }
      const result =
        scope === "turn" ? await commands.gitTurnDiff(threadId!) : await commands.gitDiff(projectId, scope);
      if (!active) return;
      setLoaded(
        result.status === "ok"
          ? { state: "ready", diff: result.data }
          : { state: "error", message: result.error.message },
      );
    };
    void load();
    const reload = () => void load();
    window.addEventListener("focus", reload);
    return () => {
      active = false;
      window.removeEventListener("focus", reload);
    };
  }, [projectId, threadId, scope, refreshKey]);

  const files = loaded.state === "ready" ? loaded.diff.files : [];
  const focused = matchDiffFile(files, focus);

  useEffect(() => {
    if (!focused) return;
    document.getElementById(fileAnchor(focused.path))?.scrollIntoView?.({ block: "start" });
  }, [focused?.path, loaded.state]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="diff" aria-label="Diff">
      <div className="diff-scopes" role="tablist" aria-label="Diff scope">
        {SCOPES.map((s) => (
          <button
            key={s.scope}
            role="tab"
            aria-selected={scope === s.scope}
            onClick={() => onScopeChange(s.scope)}
          >
            {s.label}
          </button>
        ))}
        {scope === "branch" && loaded.state === "ready" && loaded.diff.base && (
          <span className="diff-base">vs {loaded.diff.base}</span>
        )}
      </div>
      {showsConcurrencyNote(scope, { board }) && (
        <div className="diff-note">May include concurrent changes from other Threads in this checkout.</div>
      )}
      <div className="diff-body">
        {loaded.state === "loading" && <div className="files-note">Loading…</div>}
        {loaded.state === "error" && <div className="files-note error">{loaded.message}</div>}
        {loaded.state === "ready" && files.length === 0 && (
          <div className="files-note">
            {scope === "branch" && !loaded.diff.base
              ? "No base branch found."
              : scope === "turn" && threadId === null
                ? "Select a Thread to see its Turn."
                : "No changes."}
          </div>
        )}
        {files.map((file) => (
          <FileDiff key={file.path} file={file} focused={file.path === focused?.path} />
        ))}
      </div>
    </section>
  );
}

const fileAnchor = (path: string) => `diff-file-${path}`;

function FileDiff({ file, focused }: { file: DiffFile; focused: boolean }) {
  return (
    <div id={fileAnchor(file.path)} className={`diff-file${focused ? " diff-file-focused" : ""}`} aria-label={`Changes to ${file.path}`}>
      <div className="diff-file-title">
        <span className={`diff-status diff-status-${file.status}`} title={file.status}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="diff-path">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="chip-added">+{file.added}</span> <span className="chip-removed">−{file.removed}</span>
      </div>
      {file.binary && <div className="files-note">Binary or too large to show.</div>}
      {file.hunks.map((hunk, i) => (
        <pre key={i} className="diff-hunk">
          <code>
            <span className="diff-hunk-header">{hunk.header}</span>
            {hunk.lines.map((line, j) => (
              <span key={j} className={`diff-line diff-${line.kind}`}>
                {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                {line.text}
              </span>
            ))}
          </code>
        </pre>
      ))}
    </div>
  );
}
