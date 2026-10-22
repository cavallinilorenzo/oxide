import { useState, type ReactNode } from "react";
import { commands, type AppError } from "./bindings";
import { pushBlockedReason } from "./gitAction";

type Outcome = { status: "ok"; data: unknown } | { status: "error"; error: AppError };

type Pending = { before: () => Promise<Outcome> | null };

/** Runs an optional step (a commit) and then pushes, asking first when the
 *  branch is `main`: push there, or branch off and push the new branch. */
export function usePushFlow(projectId: number, onDone: () => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function execute(before: Pending["before"], mode: { branch: string } | { main: boolean }) {
    setBusy(true);
    setError(null);
    const steps: (() => Promise<Outcome> | null)[] = [];
    if ("branch" in mode) steps.push(() => commands.createBranch(projectId, mode.branch));
    steps.push(before, () => commands.push(projectId, "main" in mode && mode.main));
    for (const step of steps) {
      const result = await step();
      if (result && result.status === "error") {
        setError(result.error.message);
        break;
      }
    }
    setBusy(false);
    onDone();
  }

  /** `before` is the step that precedes the push, e.g. the commit; null for a bare Push. */
  async function start(before: () => Promise<Outcome> | null) {
    setError(null);
    const result = await commands.gitStatus(projectId);
    if (result.status === "error") return setError(result.error.message);
    const blocked = pushBlockedReason(result.data);
    if (blocked) return setError(blocked);
    if (result.data.protected) return setPending({ before });
    await execute(before, { main: false });
  }

  const dialog: ReactNode = pending && (
    <MainGuard
      onCancel={() => setPending(null)}
      onMain={() => {
        const { before } = pending;
        setPending(null);
        void execute(before, { main: true });
      }}
      onBranch={(branch) => {
        const { before } = pending;
        setPending(null);
        void execute(before, { branch });
      }}
    />
  );

  return { start, dialog, busy, error, clearError: () => setError(null) };
}

function MainGuard(props: {
  onCancel: () => void;
  onMain: () => void;
  onBranch: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Push to main"
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onCancel();
        }}
      >
        <p>You are on a main branch. Push to it, or create a branch and push that instead?</p>
        <input
          autoFocus
          aria-label="New branch name"
          placeholder="New branch name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) props.onBranch(trimmed);
          }}
        />
        <div className="modal-actions">
          <button onClick={props.onCancel}>Cancel</button>
          <button onClick={props.onMain}>Push to main</button>
          <button disabled={!trimmed} onClick={() => props.onBranch(trimmed)}>
            Create branch &amp; push
          </button>
        </div>
      </div>
    </div>
  );
}
