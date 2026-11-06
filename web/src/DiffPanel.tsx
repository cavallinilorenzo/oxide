import { Skeleton } from "./Skeleton";
import { shortcutLabel } from "./shortcuts";
import { useEffect, useState } from "react";
import { useQuery, type QueryResult } from "./queryCache";
import { CheckCircleIcon, EyeIcon, GitCommitIcon, HistoryIcon, InfoIcon, RepoPushIcon, SyncIcon, UndoIcon, XIcon } from "@primer/octicons-react";
import { commands, type BlindReviewProviderOption, type Diff, type DiffFile, type PendingRestore, type PullRequestReviewThread, type RestoreChange, type RestorePreview, type Thread, type TurnPick } from "./bindings";
import { matchDiffFile } from "./diffOpen";
import { showsConcurrencyNote, turnLabel, type PanelScope } from "./diffScope";
import { splitPath } from "./diffView";
import { commitPaths } from "./gitAction";
import { usePushFlow } from "./usePushFlow";
import { BlindReviewFindings } from "./BlindReviewFindings";
import { LineComments } from "./LineComments";
import { PullRequestReviewDrafts } from "./PullRequestReviewDrafts";
import { reviewThreadsPrefix } from "./reviewKeys";
import { ReviewThreads } from "./ReviewThreads";
import { VerificationDossier } from "./VerificationDossier";

interface DiffPanelProps {
  projectId: number;
  onOpenFile: (file: DiffFile) => void;
  /** The selected Thread: the Turn scope diffs its latest Turn. */
  threadId: number | null;
  /** The provider of the selected Thread, used to mark 'same provider' for Blind review. */
  threadProvider?: string;
  /** Optional issue description or reference for Blind review. */
  threadIssue?: string | null;
  /** Called when a Blind review thread is created and started. */
  onThreadCreated?: (thread: Thread) => void;
  /** Board Threads work in their own worktree, so nothing else edits it. */
  board: boolean;
  /** The selected Thread works in its own worktree, so nothing else edits its checkout. */
  worktree: boolean;
  /** The selected Thread is running a Turn, so its draft comments can't be sent yet. */
  threadWorking?: boolean;
  /** A Turn is running in this checkout, so its files are not ours to revert. */
  turnRunning?: boolean;
  /** A Turn is running in the selected Thread's checkout, so its files are not ours to restore. */
  checkoutBusy?: boolean;
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
  /** Called after a restore, so the Transcript shows that it happened. */
  onRestored?: () => void;
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

const CHANGE_LABEL: Record<RestoreChange, string> = {
  rewritten: "goes back to how it was",
  reinstated: "comes back",
  removed: "is deleted",
};

interface RevertRequest {
  path: string;
  hunk: { index: number; header: string } | null;
}

type Loaded ={ state: "loading" } | { state: "error"; message: string } | { state: "ready"; diff: Diff };

/** Git's view of a Project's changes. State belongs to one Project, so a different one, or another scope, remounts it. */
export function DiffPanel(props: DiffPanelProps) {
  return <DiffBody key={`${props.projectId}:${props.scope}:${props.reviewedPr}`} {...props} />;
}

function DiffBody({ projectId, threadId, threadProvider, threadIssue, onThreadCreated, board, worktree, threadWorking = false, turnRunning = false, checkoutBusy = false, scope, reviewedPr, onScopeChange, focus, refreshKey, onChanged, onRestored, onOpenPullRequest, onOpenFile }: DiffPanelProps) {
  // The window regaining focus reloads the diff, like the Pull request tab.
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const bump = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", bump);
    return () => window.removeEventListener("focus", bump);
  }, []);
  // The Turn scope lists the Thread's Turns; the latest is the default, and a pick holds only for its Thread.
  const turnsQuery = useQuery(
    `p${projectId}:turns:${scope === "turn" ? (threadId ?? "") : "-"}`,
    async (): Promise<QueryResult<TurnPick[]>> =>
      scope === "turn" && threadId !== null ? await commands.listTurnPicks(threadId) : { status: "ok", data: [] },
    `${refreshKey}#${focusTick}`,
  );
  const turns = turnsQuery.state === "ready" ? (turnsQuery.data ?? []) : [];
  const [chosenTurn, setChosenTurn] = useState<{ threadId: number | null; turnIndex: number } | null>(null);
  const turn =
    turns.find((t) => chosenTurn?.threadId === threadId && t.turnIndex === chosenTurn.turnIndex) ?? turns[turns.length - 1] ?? null;
  const noCheckpoints = scope === "turn" && turn !== null && !turn.checkpointed;
  const query = useQuery(
    `p${projectId}:diff:${scope}:${threadId ?? ""}:${reviewedPr ?? ""}:${scope === "turn" ? (turn?.turnIndex ?? "") : ""}`,
    async (): Promise<QueryResult<Diff>> => {
      if ((scope === "turn" && (threadId === null || turn === null || noCheckpoints)) || (scope === "pr" && reviewedPr === null)) {
        return { status: "ok", data: { base: null, files: [] } };
      }
      return scope === "turn"
        ? await commands.gitTurnDiff(threadId!, turn!.turnIndex)
        : scope === "pr"
          ? await commands.pullRequestDetail(projectId, reviewedPr!).then((r) =>
              r.status === "ok" ? { status: "ok" as const, data: r.data.diff } : r,
            )
          : await commands.gitDiff(projectId, threadId, scope);
    },
    `${refreshKey}#${focusTick}`,
  );
  const loaded: Loaded = query.state === "ready" ? { state: "ready", diff: query.data } : query;
  // Review threads load beside the diff, so a GitHub failure leaves the files readable.
  const threads = useQuery(
    `${reviewThreadsPrefix(projectId)}${scope}:${reviewedPr ?? ""}`,
    async (): Promise<QueryResult<PullRequestReviewThread[]>> =>
      scope === "pr" && reviewedPr !== null
        ? await commands.pullRequestReviewThreads(projectId, reviewedPr)
        : { status: "ok", data: [] },
    `${refreshKey}#${focusTick}`,
  );
  const reviewThreads = threads.state === "ready" ? threads.data : [];
  // Files the user took out of the commit; everything starts checked.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const push = usePushFlow(projectId, threadId, onChanged, onOpenPullRequest);

  const files = loaded.state === "ready" ? loaded.diff.files : [];
  const focused = matchDiffFile(files, focus);
  const canCommit = scope === "uncommitted" && files.length > 0;
  const selected = commitPaths(files, unchecked);
  const ready = selected.length > 0 && message.trim() !== "" && !committing && !push.busy;

  const commit = () => commands.commit(projectId, threadId, selected, message);
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

  // Revert: Uncommitted and Turn only, never under a running Turn.
  // Core reverts the latest Turn only, so an older picked Turn is read-only.
  const showsLatestTurn = turn !== null && turn.turnIndex === turns[turns.length - 1]?.turnIndex;
  const canRevert = (scope === "uncommitted" || (scope === "turn" && threadId !== null && showsLatestTurn)) && !turnRunning;
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<RevertRequest | null>(null);
  async function revert(request: RevertRequest, confirmDelete: boolean) {
    if (scope !== "uncommitted" && scope !== "turn") return;
    const status = files.find((f) => f.path === request.path)?.status;
    if (!confirmDelete && (status === "added" || status === "untracked")) {
      setRevertError(null);
      setConfirming(request);
      return;
    }
    setConfirming(null);
    setRevertError(null);
    setReverting(true);
    const result = await commands.revertDiff(projectId, threadId, scope, request.path, request.hunk, confirmDelete);
    setReverting(false);
    if (result.status === "error") return setRevertError(result.error.message);
    onChanged();
  }

  // Restore: the Thread's files go back to how they were before the picked Turn.
  // It is offered on a Turn with a Checkpoint, never while a Turn runs in the Thread's
  // own checkout, and it asks first, naming the files that change.
  const canRestore = scope === "turn" && threadId !== null && turn !== null && turn.checkpointed && !checkoutBusy;
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const pendingQuery = useQuery(
    `p${projectId}:pendingRestore:${threadId ?? ""}`,
    async (): Promise<QueryResult<PendingRestore | null>> =>
      threadId !== null ? await commands.pendingRestore(threadId) : { status: "ok", data: null },
    `${refreshKey}#${focusTick}`,
  );
  const pendingRestore = pendingQuery.state === "ready" ? pendingQuery.data : null;

  async function askRestore() {
    if (threadId === null || turn === null) return;
    setRestoreError(null);
    const result = await commands.restorePreview(threadId, turn.turnIndex);
    if (result.status === "error") return setRestoreError(result.error.message);
    setRestorePreview(result.data);
  }

  async function doRestore() {
    if (threadId === null || !restorePreview) return;
    setRestoring(true);
    const result = await commands.restoreTurn(threadId, restorePreview.turnIndex);
    setRestoring(false);
    if (result.status === "error") return setRestoreError(result.error.message);
    setRestorePreview(null);
    onChanged();
    onRestored?.();
  }

  async function doUndoRestore() {
    if (threadId === null) return;
    setRestoring(true);
    const result = await commands.undoRestore(threadId);
    setRestoring(false);
    if (result.status === "error") return setRestoreError(result.error.message);
    onChanged();
    onRestored?.();
  }

  // Blind review: runs the diff and issue against a provider in a separate Thread and detached worktree.
  const [blindReviewOpen, setBlindReviewOpen] = useState(false);
  const [blindProviders, setBlindProviders] = useState<BlindReviewProviderOption[]>([]);
  const [blindLoading, setBlindLoading] = useState(false);
  const [selectedBlindProvider, setSelectedBlindProvider] = useState<string>("");
  const [blindIssue, setBlindIssue] = useState<string>("");
  const [startingBlindReview, setStartingBlindReview] = useState(false);
  const [blindError, setBlindError] = useState<string | null>(null);

  async function openBlindReview() {
    setBlindReviewOpen(true);
    setBlindError(null);
    setBlindLoading(true);
    setBlindIssue(threadIssue ?? "");
    const res = await commands.blindReviewProviders(threadProvider ?? null);
    setBlindLoading(false);
    if (res.status === "ok") {
      setBlindProviders(res.data);
      if (res.data.length > 0) {
        setSelectedBlindProvider(res.data[0].provider);
      }
    } else {
      setBlindError(res.error.message);
    }
  }

  async function runBlindReview() {
    if (!selectedBlindProvider) return;
    setStartingBlindReview(true);
    setBlindError(null);
    const res = await commands.startBlindReview({
      projectId,
      threadId,
      provider: selectedBlindProvider,
      scope,
      turnIndex: scope === "turn" ? (turn?.turnIndex ?? null) : null,
      issue: blindIssue.trim() || null,
    });
    setStartingBlindReview(false);
    if (res.status === "error") {
      setBlindError(res.error.message);
      return;
    }
    setBlindReviewOpen(false);
    onThreadCreated?.(res.data);
    onChanged();
  }

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
        {scope === "turn" && turns.length > 0 && turn !== null && (
          <select
            className="turn-pick"
            aria-label="Turn"
            value={turn.turnIndex}
            onChange={(e) => setChosenTurn({ threadId, turnIndex: Number(e.target.value) })}
          >
            {turns.map((t) => (
              <option key={t.turnIndex} value={t.turnIndex}>
                {turnLabel(t)}
              </option>
            ))}
          </select>
        )}
        {canRestore && (
          <button
            type="button"
            className="btn"
            aria-label={`Restore the files to before Turn ${turn.turnIndex + 1}`}
            disabled={restoring}
            onClick={() => void askRestore()}
          >
            <HistoryIcon size={14} /> Restore
          </button>
        )}
        {pendingRestore && threadId !== null && !checkoutBusy && (
          <button
            type="button"
            className="btn"
            aria-label="Undo the restore"
            disabled={restoring}
            onClick={() => void doUndoRestore()}
          >
            <UndoIcon size={14} /> Undo restore
          </button>
        )}
        {(scope === "branch" || scope === "pr") && loaded.state === "ready" && loaded.diff.base && (
          <span className="diff-base mono">vs {loaded.diff.base}</span>
        )}
        <span className="grow" />
        {files.length > 0 && (
          <button
            type="button"
            className="btn"
            aria-label="Blind review"
            onClick={() => void openBlindReview()}
          >
            <EyeIcon size={14} /> Blind review
          </button>
        )}
        {files.length > 0 && (
          <span className="diff-total">
            {files.length} file{files.length === 1 ? "" : "s"} <span className="add">+{added}</span>{" "}
            <span className="del">−{removed}</span>
          </span>
        )}
      </div>
      {showsConcurrencyNote(scope, { board, worktree }) && (
        <div className="surface-note">
          <InfoIcon size={12} /> May include concurrent changes from other Threads in this checkout.
        </div>
      )}
      {restorePreview && (
        <div className="restore-confirm" role="alertdialog" aria-label="Confirm restore">
          <span>
            Put the files back to how they were before Turn {restorePreview.turnIndex + 1}?
          </span>
          {restorePreview.files.length === 0 ? (
            <span>No file stands between the checkout and that Turn.</span>
          ) : (
            <ul>
              {restorePreview.files.map((file) => (
                <li key={file.path}>
                  <span className="mono">{file.path}</span> {CHANGE_LABEL[file.change]}
                </li>
              ))}
            </ul>
          )}
          <div className="restore-actions">
            <button type="button" className="btn primary" disabled={restoring} onClick={() => void doRestore()}>
              Restore
            </button>
            <button type="button" className="btn" onClick={() => setRestorePreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {restoreError && <div className="error" role="alert">{restoreError}</div>}
      {threadId !== null && (
        <VerificationDossier
          projectId={projectId}
          threadId={threadId}
          scope={scope}
          refreshKey={`${refreshKey}#${focusTick}`}
          onOpenFile={(path) => {
            const file = files.find((candidate) => candidate.path === path || candidate.oldPath === path);
            if (file) setPicked(file.path);
          }}
        />
      )}
      {push.dialog}
      {blindReviewOpen && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Blind review"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !startingBlindReview) setBlindReviewOpen(false);
            }}
          >
            <h2>Blind review</h2>
            <p className="hint">
              Review changes with a fresh provider in a separate thread and detached worktree. The review prompt only includes the diff, issue, and structured format—no transcript history is shared.
            </p>
            {blindLoading ? (
              <p>Loading available providers…</p>
            ) : blindProviders.length === 0 ? (
              <p className="error" role="alert">
                No provider is available that can honour a non-writing configuration.
              </p>
            ) : (
              <div className="blind-review-fields">
                <label>
                  <span>Provider</span>
                  <select
                    aria-label="Provider"
                    value={selectedBlindProvider}
                    onChange={(e) => setSelectedBlindProvider(e.target.value)}
                    disabled={startingBlindReview}
                  >
                    {blindProviders.map((p) => (
                      <option key={p.provider} value={p.provider}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Issue reference or description (optional)</span>
                  <input
                    type="text"
                    aria-label="Issue"
                    placeholder="e.g. #123 or issue description"
                    value={blindIssue}
                    onChange={(e) => setBlindIssue(e.target.value)}
                    disabled={startingBlindReview}
                  />
                </label>
              </div>
            )}
            {blindError && (
              <div className="error" role="alert">
                {blindError}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setBlindReviewOpen(false)}
                disabled={startingBlindReview}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={
                  startingBlindReview || blindLoading || blindProviders.length === 0 || !selectedBlindProvider
                }
                onClick={() => void runBlindReview()}
              >
                {startingBlindReview ? "Starting…" : "Start Blind review"}
              </button>
            </div>
          </div>
        </div>
      )}
      {loaded.state === "loading" && <Skeleton kind="diff" label="Loading changes…" />}
      {loaded.state === "error" && <div className="surface-empty error">{loaded.message}</div>}
      {scope === "pr" && loaded.state !== "error" && threads.state === "error" && (
        <div className="surface-empty error" role="alert">
          {threads.message}
        </div>
      )}
      {scope === "pr" && loaded.state === "ready" && reviewThreads.length > 0 && (
        <ReviewThreads diff={loaded.diff} threads={reviewThreads} />
      )}
      {loaded.state === "ready" && files.length === 0 && (
        <div className="surface-empty">
          <CheckCircleIcon size={20} />
          {scope === "branch" && !loaded.diff.base
            ? "No base branch found."
            : scope === "turn" && threadId === null
              ? "Select a Thread to see its Turn."
              : noCheckpoints
                ? "This Turn has no Checkpoints, so there is no diff to show."
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
                  {canRevert && (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Revert ${file.path}`}
                      disabled={reverting}
                      onClick={(e) => { e.stopPropagation(); void revert({ path: file.path, hunk: null }, false); }}
                    >
                      Revert
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {canRevert && current && current.hunks.length > 1 && (
            <ul className="diff-hunks" aria-label={`Hunks of ${current.path}`}>
              {current.hunks.map((hunk, index) => (
                <li key={`${index}:${hunk.header}`} className="diff-hunk-row">
                  <span className="mono">{hunk.header}</span>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Revert hunk ${hunk.header} of ${current.path}`}
                    disabled={reverting}
                    onClick={() => void revert({ path: current.path, hunk: { index, header: hunk.header } }, false)}
                  >
                    Revert hunk
                  </button>
                </li>
              ))}
            </ul>
          )}
          {confirming && (
            <div className="surface-note" role="alertdialog" aria-label="Confirm revert">
              <span>Reverting {confirming.path} deletes the file.</span>
              <button type="button" className="btn primary" onClick={() => void revert(confirming, true)}>Delete file</button>
              <button type="button" className="btn" onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          )}
          {revertError && <div className="error" role="alert">{revertError}</div>}
        </div>
      )}
      {threadId !== null && (
        <BlindReviewFindings projectId={projectId} threadId={threadId} refreshKey={`${refreshKey}#${focusTick}`} />
      )}
      {threadId !== null && <LineComments projectId={projectId} threadId={threadId} working={threadWorking} refreshKey={`${refreshKey}#${focusTick}`} />}
      {scope === "pr" && reviewedPr !== null && (
        <PullRequestReviewDrafts
          projectId={projectId}
          pullRequest={reviewedPr}
          refreshKey={`${refreshKey}#${focusTick}`}
          onSubmitted={onChanged}
        />
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
          {push.warning && (
            <div className="git-note" role="status" title={push.warning}>
              <span>{push.warning}</span>
              <button className="icon-btn sm" aria-label="Dismiss notice" onClick={push.clearWarning}>
                <XIcon size={12} />
              </button>
            </div>
          )}
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
