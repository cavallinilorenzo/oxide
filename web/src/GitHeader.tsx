import { Skeleton } from "./Skeleton";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "./queryCache";
import {
  CheckIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  PlusIcon,
  RepoPullIcon,
  RepoPushIcon,
  SyncIcon,
  TriangleDownIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands, type AppError, type GitBranch, type GitStatus } from "./bindings";
import { canCreateBranch, filterBranches } from "./branchFilter";
import { createPrBlockedReason, nextAction, pushBlockedReason } from "./gitAction";
import { usePushFlow } from "./usePushFlow";

interface GitHeaderProps {
  projectId: number;
  /** The Thread whose checkout every control here acts on. */
  threadId: number;
  /** Changes whenever a Thread's status does, so the picker lock stays current. */
  threadsKey: string;
  onOpenDiff: () => void;
  onOpenPullRequest: () => void;
  /** Called after Git changed the checkout or its remote, so other views reload. */
  onChanged: () => void;
}

type Outcome = { status: "ok"; data: unknown } | { status: "error"; error: AppError };

/** The Git controls under a Thread's title: branch picker, dirty chip, Pull and Commit & Push.
 *  State belongs to one Thread, so selecting another remounts it: a late answer or an unsubmitted
 *  dialog of the old selection can neither show nor operate on the new one. */
export function GitHeader(props: GitHeaderProps) {
  return <GitHeaderBody key={`${props.projectId}:${props.threadId}`} {...props} />;
}

function GitHeaderBody({ projectId, threadId, threadsKey, onOpenDiff, onOpenPullRequest, onChanged }: GitHeaderProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set false on unmount: an answer for a deselected Thread is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open && !menuOpen) return;
    const pointer = (event: PointerEvent) => {
      if (!branchRef.current?.contains(event.target as Node)) setOpen(false);
      if (!actionsRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); setMenuOpen(false); } };
    document.addEventListener("pointerdown", pointer); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open, menuOpen]);

  const refresh = useCallback(
    () =>
      commands.gitStatus(projectId, threadId).then((result) => {
        if (!mounted.current) return;
        setStatus(result.status === "ok" ? result.data : null);
        setLoadError(result.status === "error" ? result.error.message : null);
      }),
    [projectId, threadId],
  );
  const push = usePushFlow(
    projectId,
    threadId,
    () => {
      void refresh();
      onChanged();
    },
    onOpenPullRequest,
  );

  // Fetch when the Project opens and when the window regains focus. Core
  // throttles, and a failed background fetch (offline) isn't worth showing.
  useEffect(() => {
    const sync = () => {
      void commands.fetchProject(projectId).then(refresh);
    };
    void refresh();
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [projectId, refresh]);

  useEffect(() => {
    void refresh();
  }, [threadsKey, refresh]);

  async function act(run: () => Promise<Outcome>) {
    setBusy(true);
    setError(null);
    const result = await run();
    if (mounted.current) {
      if (result.status === "error") setError(result.error.message);
      setBusy(false);
    }
    if (result.status === "ok") onChanged();
    await refresh();
  }

  if (!status) {
    return loadError ? (
      <div className="git-header">
        <span className="git-error" role="alert" title={loadError}>
          <span className="git-error-text">{loadError}</span>
        </span>
      </div>
    ) : null;
  }
  const action = nextAction(status);
  const pushNow = () => push.start(() => null);
  const disabledReason = status.pickerDisabledReason ?? (busy ? "Working…" : null);
  const dirty = status.changedFiles > 0;

  return (
    <div className="git-header">
      <div className="branch-picker" ref={branchRef}>
        <button
          className="hdrbtn branch-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabledReason !== null}
          title={disabledReason ?? `Switch branch: ${status.branch ?? "detached HEAD"}`}
          onClick={() => setOpen((v) => !v)}
        >
          <GitBranchIcon size={14} />
          <span className="branch-name">{status.branch ?? "detached HEAD"}</span>
          <ChevronDownIcon size={12} />
        </button>
        {open && (
          <BranchMenu
            projectId={projectId}
            threadId={threadId}
            onClose={() => setOpen(false)}
            onCheckout={(name) => act(() => commands.checkoutBranch(projectId, threadId, name))}
            onCreate={(name) => act(() => commands.createBranch(projectId, threadId, name))}
          />
        )}
      </div>
      {dirty && (
        <button
          className="chip dirty-chip"
          title={`${status.changedFiles} changed file${status.changedFiles === 1 ? "" : "s"}`}
          onClick={onOpenDiff}
        >
          <span className="chip-added">+{status.added}</span> <span className="chip-removed">−{status.removed}</span>
        </button>
      )}
      {status.behind > 0 && (
        <button
          className={`btn pull-button${busy ? " pending" : ""}`}
          disabled={busy}
          title={`Fast-forward ${status.behind} commit${status.behind === 1 ? "" : "s"} from ${status.upstream ?? "upstream"}`}
          onClick={() => void act(() => commands.pull(projectId, threadId))}
        >
          {busy ? <SyncIcon size={14} className="spin" /> : <RepoPullIcon size={14} />} Pull
        </button>
      )}
      <div ref={actionsRef} className={`split-button${action.kind === "up-to-date" ? "" : " primary"}`}>
        <button
          className={`git-primary${busy || push.busy ? " pending" : ""}`}
          disabled={busy || push.busy || action.kind === "up-to-date" || action.blockedReason !== null}
          title={action.blockedReason ?? undefined}
          onClick={() => (action.kind === "commit-push" ? onOpenDiff() : void pushNow())}
        >
          {busy || push.busy ? <SyncIcon size={14} className="spin" /> : action.kind === "up-to-date" ? <CheckIcon size={14} /> : action.kind === "commit-push" ? <GitCommitIcon size={14} /> : <RepoPushIcon size={14} />}
          {action.label.replace(/^✓\s*/, "")}
        </button>
        <button
          className="git-menu-toggle"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="More Git actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <TriangleDownIcon size={14} />
        </button>
        {menuOpen && (
          <div
            className="git-menu"
            role="menu"
            onKeyDown={(e) => {
              if (e.key === "Escape") setMenuOpen(false);
            }}
          >
            <button role="menuitem" disabled={!dirty} onClick={() => (setMenuOpen(false), onOpenDiff())}>
              <GitCommitIcon size={14} /> Commit…
            </button>
            <button
              role="menuitem"
              disabled={!(status.ahead > 0 || status.unpublished) || pushBlockedReason(status) !== null}
              title={pushBlockedReason(status) ?? undefined}
              onClick={() => (setMenuOpen(false), void pushNow())}
            >
              <RepoPushIcon size={14} /> Push
            </button>
            <button
              role="menuitem"
              disabled={createPrBlockedReason(status) !== null}
              title={createPrBlockedReason(status) ?? undefined}
              onClick={() => (setMenuOpen(false), onOpenPullRequest())}
            >
              <GitPullRequestIcon size={14} /> Create PR
            </button>
          </div>
        )}
      </div>
      {push.dialog}
      {(error ?? push.error) && (
        <span className="git-error" role="alert" title={error ?? push.error ?? undefined}>
          <span className="git-error-text">{error ?? push.error}</span>
          <button
            className="icon-btn sm"
            aria-label="Dismiss error"
            onClick={() => {
              setError(null);
              push.clearError();
            }}
          >
            <XIcon size={12} />
          </button>
        </span>
      )}
    </div>
  );
}

interface BranchMenuProps {
  projectId: number;
  threadId: number;
  onClose: () => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}

function BranchMenu({ projectId, threadId, onClose, onCheckout, onCreate }: BranchMenuProps) {
  const result = useQuery(`p${projectId}:branches:t${threadId}`, () => commands.listBranches(projectId, threadId));
  const branches: GitBranch[] | null =
    result.state === "ready" ? result.data : result.state === "error" ? [] : null;
  const [query, setQuery] = useState("");

  function choose(run: () => Promise<void>) {
    onClose();
    void run();
  }

  const shown = filterBranches(branches ?? [], query);
  const name = query.trim();
  return (
    <div
      className="branch-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <input
        autoFocus
        aria-label="Search branches"
        placeholder="Search or create a branch"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // Only an exact name checks out, so "feat" never lands on "feature".
          const exact = shown.find((b) => b.name === name);
          if (exact) choose(() => onCheckout(exact.name));
          else if (shown.length === 0 && name) choose(() => onCreate(name));
        }}
      />
      <ul role="listbox" aria-label="Branches">
        {branches === null && <li role="presentation"><Skeleton kind="picker" label="Loading branches…" /></li>}
        {shown.map((b) => (
          <li key={`${b.remote}:${b.name}`} role="option" aria-selected={b.current}>
            <button disabled={b.current} onClick={() => choose(() => onCheckout(b.name))}>
              <span className="menu-check">{b.current && <CheckIcon size={12} />}</span>
              <span className="branch-name">{b.name}</span>
              {b.remote && <span className="badge">remote</span>}
            </button>
          </li>
        ))}
        {branches !== null && canCreateBranch(branches, query) && (
          <li>
            <button onClick={() => choose(() => onCreate(name))}>
              <PlusIcon size={12} /> Create “{name}” from HEAD
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
