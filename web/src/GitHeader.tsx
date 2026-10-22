import { useCallback, useEffect, useState } from "react";
import { commands, type AppError, type GitBranch, type GitStatus } from "./bindings";
import { canCreateBranch, filterBranches } from "./branchFilter";
import { createPrBlockedReason, nextAction, pushBlockedReason } from "./gitAction";
import { usePushFlow } from "./usePushFlow";

interface GitHeaderProps {
  projectId: number;
  /** Changes whenever a Thread's status does, so the picker lock stays current. */
  threadsKey: string;
  onOpenDiff: () => void;
  onOpenPullRequest: () => void;
  /** Called after Git changed the checkout or its remote, so other views reload. */
  onChanged: () => void;
}

type Outcome = { status: "ok"; data: unknown } | { status: "error"; error: AppError };

/** The left half of the Git header: branch picker, dirty chip and Pull.
 *  State belongs to one Project, so a different one remounts it. */
export function GitHeader(props: GitHeaderProps) {
  return <GitHeaderBody key={props.projectId} {...props} />;
}

function GitHeaderBody({ projectId, threadsKey, onOpenDiff, onOpenPullRequest, onChanged }: GitHeaderProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(
    () =>
      commands.gitStatus(projectId).then((result) => {
        setStatus(result.status === "ok" ? result.data : null);
      }),
    [projectId],
  );
  const push = usePushFlow(
    projectId,
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
    if (result.status === "error") setError(result.error.message);
    else onChanged();
    setBusy(false);
    await refresh();
  }

  if (!status) return null;
  const action = nextAction(status);
  const pushNow = () => push.start(() => null);
  const disabledReason = status.pickerDisabledReason ?? (busy ? "Working…" : null);
  const dirty = status.changedFiles > 0;

  return (
    <div className="git-header">
      <div className="branch-picker">
        <button
          className="branch-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabledReason !== null}
          title={disabledReason ?? "Switch branch"}
          onClick={() => setOpen((v) => !v)}
        >
          ⎇ {status.branch ?? "detached HEAD"}
        </button>
        {open && (
          <BranchMenu
            projectId={projectId}
            onClose={() => setOpen(false)}
            onCheckout={(name) => act(() => commands.checkoutBranch(projectId, name))}
            onCreate={(name) => act(() => commands.createBranch(projectId, name))}
          />
        )}
      </div>
      {status.pickerDisabledReason && <span className="git-reason">{status.pickerDisabledReason}</span>}
      {dirty && (
        <button
          className="dirty-chip"
          title={`${status.changedFiles} changed file${status.changedFiles === 1 ? "" : "s"}`}
          onClick={onOpenDiff}
        >
          <span className="chip-added">+{status.added}</span> <span className="chip-removed">−{status.removed}</span>
        </button>
      )}
      {status.behind > 0 && (
        <button
          className="pull-button"
          disabled={busy}
          title={`Fast-forward from ${status.upstream ?? "upstream"}`}
          onClick={() => void act(() => commands.pull(projectId))}
        >
          Pull ↓{status.behind}
        </button>
      )}
      <div className="split-button">
        <button
          className="git-primary"
          disabled={busy || push.busy || action.kind === "up-to-date" || action.blockedReason !== null}
          title={action.blockedReason ?? undefined}
          onClick={() => (action.kind === "commit-push" ? onOpenDiff() : void pushNow())}
        >
          {action.label}
        </button>
        <button
          className="git-menu-toggle"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="More Git actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ▾
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
              Commit…
            </button>
            <button
              role="menuitem"
              disabled={!(status.ahead > 0 || status.unpublished) || pushBlockedReason(status) !== null}
              title={pushBlockedReason(status) ?? undefined}
              onClick={() => (setMenuOpen(false), void pushNow())}
            >
              Push
            </button>
            <button
              role="menuitem"
              disabled={createPrBlockedReason(status) !== null}
              title={createPrBlockedReason(status) ?? undefined}
              onClick={() => (setMenuOpen(false), onOpenPullRequest())}
            >
              Create PR
            </button>
          </div>
        )}
      </div>
      {push.dialog}
      {(error ?? push.error) && (
        <span className="git-error" role="alert" title={error ?? push.error ?? undefined}>
          <span className="git-error-text">{error ?? push.error}</span>
          <button
            aria-label="Dismiss error"
            onClick={() => {
              setError(null);
              push.clearError();
            }}
          >
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

interface BranchMenuProps {
  projectId: number;
  onClose: () => void;
  onCheckout: (name: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}

function BranchMenu({ projectId, onClose, onCheckout, onCreate }: BranchMenuProps) {
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void commands.listBranches(projectId).then((result) => {
      setBranches(result.status === "ok" ? result.data : []);
    });
  }, [projectId]);

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
        {branches === null && <li className="empty">Loading…</li>}
        {shown.map((b) => (
          <li key={`${b.remote}:${b.name}`} role="option" aria-selected={b.current}>
            <button disabled={b.current} onClick={() => choose(() => onCheckout(b.name))}>
              {b.current ? "✓ " : ""}
              {b.name}
              {b.remote && <span className="badge">remote</span>}
            </button>
          </li>
        ))}
        {branches !== null && canCreateBranch(branches, query) && (
          <li>
            <button onClick={() => choose(() => onCreate(name))}>Create “{name}” from HEAD</button>
          </li>
        )}
      </ul>
    </div>
  );
}
