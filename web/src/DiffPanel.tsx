import { useEffect, useState } from "react";
import { commands, type Diff, type DiffFile, type DiffScope } from "./bindings";
import { matchDiffFile } from "./diffOpen";
import { commitPaths } from "./gitAction";
import { usePushFlow } from "./usePushFlow";

interface DiffPanelProps {
  projectId: number;
  scope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  /** A file hint from the chat to scroll to and highlight. */
  focus: string | null;
  /** Changes whenever a Thread's status does, so the diff stays current. */
  refreshKey: string;
  /** Called after a commit or push, so other Git views reload. */
  onChanged: () => void;
}

const SCOPES: { scope: DiffScope; label: string }[] = [
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

function DiffBody({ projectId, scope, onScopeChange, focus, refreshKey, onChanged }: DiffPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // Files the user took out of the commit; everything starts checked.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const push = usePushFlow(projectId, onChanged);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const result = await commands.gitDiff(projectId, scope);
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
  }, [projectId, scope, refreshKey]);

  const files = loaded.state === "ready" ? loaded.diff.files : [];
  const focused = matchDiffFile(files, focus);
  const canCommit = scope === "uncommitted" && files.length > 0;
  const selected = commitPaths(files, unchecked);
  const ready = selected.length > 0 && message.trim() !== "" && !committing && !push.busy;

  const commit = () => commands.commit(projectId, selected, message);
  async function runCommit(andPush: boolean) {
    setCommitError(null);
    if (andPush) {
      // The message is kept if the commit or push fails; clear it only once committed.
      await push.start(async () => {
        const result = await commit();
        if (result.status === "ok") setMessage("");
        return result;
      });
      return;
    }
    setCommitting(true);
    const result = await commit();
    setCommitting(false);
    if (result.status === "error") return setCommitError(result.error.message);
    setMessage("");
    onChanged();
  }

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
      {canCommit && (
        <form
          className="commit-form"
          aria-label="Commit"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void runCommit(false);
          }}
        >
          <textarea
            aria-label="Commit message"
            placeholder="Commit message"
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="commit-actions">
            <span className="commit-count">
              {selected.length === 0 ? "No files selected" : `${files.length - unchecked.size} of ${files.length} files`}
            </span>
            <button type="submit" disabled={!ready}>
              Commit
            </button>
            <button type="button" disabled={!ready} onClick={() => void runCommit(true)}>
              Commit &amp; Push
            </button>
          </div>
          {(commitError ?? push.error) && (
            <div className="files-note error" role="alert">
              {commitError ?? push.error}
            </div>
          )}
        </form>
      )}
      {push.dialog}
      <div className="diff-body">
        {loaded.state === "loading" && <div className="files-note">Loading…</div>}
        {loaded.state === "error" && <div className="files-note error">{loaded.message}</div>}
        {loaded.state === "ready" && files.length === 0 && (
          <div className="files-note">
            {scope === "branch" && !loaded.diff.base ? "No base branch found." : "No changes."}
          </div>
        )}
        {files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            focused={file.path === focused?.path}
            checkbox={
              canCommit
                ? {
                    checked: !unchecked.has(file.path),
                    onChange: (checked) =>
                      setUnchecked((prev) => {
                        const next = new Set(prev);
                        if (checked) next.delete(file.path);
                        else next.add(file.path);
                        return next;
                      }),
                  }
                : null
            }
          />
        ))}
      </div>
    </section>
  );
}

const fileAnchor = (path: string) => `diff-file-${path}`;

function FileDiff({
  file,
  focused,
  checkbox,
}: {
  file: DiffFile;
  focused: boolean;
  checkbox: { checked: boolean; onChange: (checked: boolean) => void } | null;
}) {
  return (
    <div id={fileAnchor(file.path)} className={`diff-file${focused ? " diff-file-focused" : ""}`} aria-label={`Changes to ${file.path}`}>
      <div className="diff-file-title">
        {checkbox && (
          <input
            type="checkbox"
            aria-label={`Include ${file.path} in the commit`}
            checked={checkbox.checked}
            onChange={(e) => checkbox.onChange(e.target.checked)}
          />
        )}
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
