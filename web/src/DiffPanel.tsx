import { Skeleton } from "./Skeleton";
import { shortcutLabel } from "./shortcuts";
import { useEffect, useState } from "react";
import { useQuery, type QueryResult } from "./queryCache";
import { CheckCircleIcon, GitCommitIcon, InfoIcon, RepoPushIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type Diff, type DiffFile } from "./bindings";
import { matchDiffFile } from "./diffOpen";
import { showsConcurrencyNote, type PanelScope } from "./diffScope";
import { splitPath } from "./diffView";
import { commitPaths } from "./gitAction";
import { usePushFlow } from "./usePushFlow";

interface DiffPanelProps {
  projectId: number;
  onOpenFile: (file: DiffFile) => void;
  /** The selected Thread: the Turn scope diffs its latest Turn. */
  threadId: number | null;
  /** Board Threads work in their own worktree, so nothing else edits it. */
  board: boolean;
  scope: PanelScope;
  /** The pull request whose files the PR scope shows, once one was opened for review. */
  reviewedPr: number | null;
  onScopeChange: (scope: PanelScope) => void;
  /** A file hint from the chat to scroll to and highlight. */
  focus: string | null;
  /** Changes whenever a Thread's status does, so the diff stays current. */
  refreshKey: string;
  /** Called after a commit or push, so other Git views reload. */
  onChanged: () => void;
  /** Shows the Pull request Surface, after a push that offered to open one. */
  onOpenPullRequest: () => void;
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
  return <DiffBody key={`${props.projectId}:${props.scope}:${props.reviewedPr}`} {...props} />;
}

function DiffBody({ projectId, threadId, board, scope, reviewedPr, onScopeChange, focus, refreshKey, onChanged, onOpenPullRequest, onOpenFile }: DiffPanelProps) {
  // The window regaining focus reloads the diff, like the Pull request tab.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const bump = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, []);
  const query = useQuery(
    `p${projectId}:diff:${scope}:${threadId ?? ""}:${reviewedPr ?? ""}`,
    async (): Promise<QueryResult<Diff>> => {
      if ((scope === "turn" && threadId === null) || (scope === "pr" && reviewedPr === null)) {
        return { status: "ok", data: { base: null, files: [] } };
      }
      return scope === "turn"
        ? await commands.gitTurnDiff(threadId!)
        : scope === "pr"
          ? await commands.pullRequestDetail(projectId, reviewedPr!).then((r) =>
              r.status === "ok" ? { status: "ok" as const, data: r.data.diff } : r,
            )
          : await commands.gitDiff(projectId, scope);
    },
    `${refreshKey}#${focusTick}`,
  );
  const loaded: Loaded = query.state === "ready" ? { state: "ready", diff: query.data } : query;
  // Files the user took out of the commit; everything starts checked.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const push = usePushFlow(projectId, onChanged, onOpenPullRequest);

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

  // The file shown on the right: the user's pick, a hint from the chat, else the first.
  // A pick holds until the chat points at another file.
  const [pick, setPick] = useState<{ path: string; focus: string | null } | null>(null);
  const picked = pick && pick.focus === focus ? files.find((f) => f.path === pick.path) : undefined;
  const current = picked ?? focused ?? files[0] ?? null;
  const setPicked = (path: string) => setPick({ path, focus });
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  const toggleChecked = (path: string, checked: boolean) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section className="diff" aria-label="Diff">
      <div className="surface-bar">
        <div className="seg" role="tablist" aria-label="Diff scope">
          {(reviewedPr === null ? SCOPES : [...SCOPES, { scope: "pr" as const, label: `PR #${reviewedPr}` }]).map((s) => (
            <button
              key={s.scope}
              role="tab"
              aria-selected={scope === s.scope}
              onClick={() => onScopeChange(s.scope)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {(scope === "branch" || scope === "pr") && loaded.state === "ready" && loaded.diff.base && (
          <span className="diff-base mono">vs {loaded.diff.base}</span>
        )}
        <span className="grow" />
        {files.length > 0 && (
          <span className="diff-total">
            {files.length} file{files.length === 1 ? "" : "s"} <span className="add">+{added}</span>{" "}
            <span className="del">−{removed}</span>
          </span>
        )}
      </div>
      {showsConcurrencyNote(scope, { board }) && (
        <div className="surface-note">
          <InfoIcon size={12} /> May include concurrent changes from other Threads in this checkout.
        </div>
      )}
      {push.dialog}
      {loaded.state === "loading" && <Skeleton kind="diff" label="Loading changes…" />}
      {loaded.state === "error" && <div className="surface-empty error">{loaded.message}</div>}
      {loaded.state === "ready" && files.length === 0 && (
        <div className="surface-empty">
          <CheckCircleIcon size={20} />
          {scope === "branch" && !loaded.diff.base
            ? "No base branch found."
            : scope === "turn" && threadId === null
              ? "Select a Thread to see its Turn."
              : "No changes."}
        </div>
      )}
      {files.length > 0 && (
        <div className="diff-split diff-navigation">
          <ul className="diff-files" role="listbox" aria-label="Changed files">
            {files.map((file) => {
              const { dir, name } = splitPath(file.path);
              return (
                <li
                  key={file.path}
                  role="option"
                  aria-selected={file.path === current?.path}
                  className="diff-file-row"
                  tabIndex={0}
                  onClick={() => { setPicked(file.path); onOpenFile(file); }}
                  onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPicked(file.path); onOpenFile(file); } }}
                  title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                >
                  {canCommit && (
                    <input
                      type="checkbox"
                      aria-label={`Include ${file.path} in the commit`}
                      checked={!unchecked.has(file.path)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => toggleChecked(file.path, e.target.checked)}
                    />
                  )}
                  <span className={`diff-status diff-status-${file.status}`} title={file.status}>
                    {STATUS_LABEL[file.status]}
                  </span>
                  <span className="diff-file-name">
                    {name}
                    {dir && <span className="diff-file-dir"> {dir}</span>}
                  </span>
                  <span className="diff-counts">
                    <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {canCommit ? (
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
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey && ready) {
                e.preventDefault();
                void runCommit(true);
              }
            }}
          />
          <div className="commit-actions">
            <span className="commit-count">
              {selected.length === 0 ? "No files selected" : `${files.filter((f) => !unchecked.has(f.path)).length} of ${files.length} files`}
            </span>
            <button type="submit" className={`btn${committing ? " pending" : ""}`} disabled={!ready}>
              {committing ? <SyncIcon size={14} className="spin" /> : <GitCommitIcon size={14} />} Commit
            </button>
            <button type="button" className={`btn primary${push.busy ? " pending" : ""}`} disabled={!ready} onClick={() => void runCommit(true)} title={`Commit & Push (${shortcutLabel}${shortcutLabel === "\u2318" ? "\u21a9" : "Enter"})`}>
              {push.busy ? <SyncIcon size={14} className="spin" /> : <RepoPushIcon size={14} />} Commit &amp; Push
            </button>
          </div>
          {(commitError ?? push.error) && (
            <div className="error" role="alert">
              {commitError ?? push.error}
            </div>
          )}
        </form>
      ) : (
        scope !== "uncommitted" && (
          <div className="surface-foot">
            Switch to{" "}
            <button className="link" onClick={() => onScopeChange("uncommitted")}>
              Uncommitted
            </button>{" "}
            to commit.
          </div>
        )
      )}
    </section>
  );
}
