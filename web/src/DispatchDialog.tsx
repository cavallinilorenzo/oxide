import { Skeleton } from "./Skeleton";
import { useEffect, useState } from "react";
import { commands, type PermissionMode, type Settings, type Thread } from "./bindings";
import {
  defaultDispatchForm,
  dispatchRequest,
  issueDispatchForm,
  withProvider,
  type DispatchForm,
  type DispatchIssue,
} from "./dispatch";

const PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "antigravity", name: "Antigravity" },
];

const PERMISSION_MODES: { id: PermissionMode; name: string }[] = [
  { id: "ask", name: "Ask" },
  { id: "auto-edit", name: "Auto-edit" },
  { id: "full-access", name: "Full access" },
];

interface DispatchDialogProps {
  projectId: number;
  /** The issue the task starts from: it prefills the prompt, and the Thread is linked to it. */
  issue?: DispatchIssue;
  onClose: () => void;
  onDispatched: (thread: Thread) => void;
}

/** Hands a task off to a new background Thread in a worktree of its own. */
export function DispatchDialog({ projectId, issue, onClose, onDispatched }: DispatchDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState<DispatchForm | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([commands.getSettings(), commands.gitStatus(projectId), commands.listBranches(projectId)]).then(
      ([state, status, list]) => {
        if (!active) return;
        const current = status.status === "ok" ? status.data.branch : null;
        setSettings(state.settings);
        const form = defaultDispatchForm(state.settings, current);
        setForm(issue ? issueDispatchForm(form, issue) : form);
        if (list.status === "ok") setBranches(list.data.filter((b) => !b.remote).map((b) => b.name));
        if (status.status === "error") setError(status.error.message);
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, issue]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const dispatch = async () => {
    if (!form || busy) return;
    setBusy(true);
    setError(null);
    const res = await commands.dispatchThread(dispatchRequest(projectId, form, issue));
    setBusy(false);
    if (res.status === "ok") onDispatched(res.data);
    else setError(res.error.message);
  };

  const set = (patch: Partial<DispatchForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <form
        className="modal dispatch-dialog"
        role="dialog"
        aria-label="Dispatch a task"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void dispatch();
        }}
      >
        <h2>{issue ? `Start a Thread from #${issue.number}` : "Dispatch a task"}</h2>
        {form === null || settings === null ? (
          <Skeleton kind="form" label="Loading task settings…" />
        ) : (
          <>
            <label>
              Prompt
              <textarea
                autoFocus
                rows={5}
                value={form.prompt}
                disabled={busy}
                onChange={(e) => set({ prompt: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void dispatch();
                  }
                }}
              />
            </label>
            <label>
              Provider
              <select
                value={form.provider}
                disabled={busy}
                onChange={(e) => setForm(withProvider(form, settings, e.target.value))}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input
                value={form.model}
                placeholder="Provider default"
                disabled={busy}
                onChange={(e) => set({ model: e.target.value })}
              />
            </label>
            <label>
              Effort
              <input
                value={form.effort}
                placeholder="Provider default"
                disabled={busy}
                onChange={(e) => set({ effort: e.target.value })}
              />
            </label>
            <label>
              Permission mode
              <select
                value={form.permissionMode}
                disabled={busy}
                onChange={(e) => set({ permissionMode: e.target.value as PermissionMode })}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Base branch
              <select value={form.baseBranch} disabled={busy} onChange={(e) => set({ baseBranch: e.target.value })}>
                {!branches.includes(form.baseBranch) && <option value={form.baseBranch}>{form.baseBranch || "HEAD"}</option>}
                {branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Starts from the branch&apos;s commits; uncommitted changes are not carried over.</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={busy ? "pending" : undefined} disabled={busy || form === null || form.prompt.trim() === ""}>
            {busy ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
      </form>
    </div>
  );
}
