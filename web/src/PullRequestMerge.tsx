import {
  AlertIcon,
  CheckCircleFillIcon,
  DotFillIcon,
  GearIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  SyncIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { useCallback, useRef, useState } from "react";
import type { MergeMethod } from "./bindings";
import { Popover } from "./Popover";
import { mergeLabel, type MergeRequirement, type Tone } from "./pullRequestReview";

export function ToneIcon({ tone, size = 16 }: { tone: Tone; size?: number }) {
  if (tone === "ok") return <CheckCircleFillIcon size={size} />;
  if (tone === "bad") return <XCircleFillIcon size={size} />;
  if (tone === "warn") return <AlertIcon size={size} />;
  return <DotFillIcon size={size} />;
}

/** Why the pull request can or can't merge, laid out the way the web merge box does. */
export function MergeStatus({
  requirements,
  busy,
  onUpdateBranch,
}: {
  requirements: MergeRequirement[];
  busy: boolean;
  onUpdateBranch: () => void;
}) {
  if (requirements.length === 0) return null;
  return (
    <section className="pr-box pr-status-box" aria-label="Merge status">
      <ul>
        {requirements.map((r) => (
          <li key={r.kind} className={`pr-req pr-req-${r.tone}`}>
            <ToneIcon tone={r.tone} />
            <div>
              <p className="pr-req-title">{r.title}</p>
              {r.detail && r.tone !== "ok" && <p className="pr-req-detail">{r.detail}</p>}
            </div>
            {r.kind === "behind" && (
              <button disabled={busy} onClick={onUpdateBranch}>
                <SyncIcon size={14} /> Update branch
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const METHOD_HELP: Record<MergeMethod, string> = {
  merge: "All commits are added to the base branch through a merge commit.",
  squash: "The commits are combined into one commit on the base branch.",
  rebase: "The commits are rebased and added onto the base branch.",
};

interface MergeFooterProps {
  draft: boolean;
  merged: boolean;
  methods: MergeMethod[];
  method: MergeMethod | null;
  head: string;
  deleteBranch: boolean;
  busy: boolean;
  canMerge: boolean;
  /** Offer to merge by itself once the checks pass: the merge is blocked only by a wait. */
  canAutoMerge: boolean;
  autoMerge: boolean;
  tone: Tone;
  status: string;
  onMethod: (method: MergeMethod) => void;
  onDeleteBranch: (on: boolean) => void;
  onMerge: () => void;
  onAutoMerge: () => void;
  onReady: () => void;
}

/** Always in view: the verdict, the merge button, and its options out of the way behind a gear. */
export function MergeFooter(p: MergeFooterProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  if (p.merged) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status ok">
          <CheckCircleFillIcon size={14} /> Merged
        </p>
      </footer>
    );
  }
  if (p.draft) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status neutral">
          <GitPullRequestDraftIcon size={14} /> Draft: not ready for review yet
        </p>
        <div className="pr-merge-row">
          <button className="primary" disabled={p.busy} onClick={p.onReady}>
            Ready for review
          </button>
        </div>
      </footer>
    );
  }
  if (p.method === null) {
    return (
      <footer className="pr-merge" aria-label="Merge">
        <p className="pr-merge-status">This repository allows no merge method.</p>
      </footer>
    );
  }
  return (
    <footer className="pr-merge" aria-label="Merge">
      <p className={`pr-merge-status ${p.tone}`}>
        <ToneIcon tone={p.tone} size={14} />
        {p.status}
      </p>
      <div className="pr-merge-row">
        <button
          className={`primary${p.tone === "bad" ? " risky" : ""}`}
          disabled={!p.canMerge}
          onClick={p.onMerge}
        >
          <GitMergeIcon size={14} /> {mergeLabel(p.method)}
        </button>
        {p.canAutoMerge && (
          <button disabled={p.busy || p.autoMerge} onClick={p.onAutoMerge} title="Merge by itself once the required checks pass">
            {p.autoMerge ? "Auto-merge on" : "Merge when ready"}
          </button>
        )}
        <button
          ref={trigger}
          className="icon-btn"
          aria-label="Merge options"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Merge options"
          onClick={() => setOpen((o) => !o)}
        >
          <GearIcon size={16} />
        </button>
      </div>
      {p.autoMerge && <p className="pr-merge-note">GitHub will merge it once the checks pass.</p>}
      {p.deleteBranch && !p.autoMerge && (
        <p className="pr-merge-note">
          <code>{p.head}</code> will be deleted after merging.
        </p>
      )}
      {open && (
        <Popover anchor={trigger} label="Merge options" onClose={close} width={300}>
          <div className="pr-options">
            <h5>Merge method</h5>
            <div role="radiogroup" aria-label="Merge method">
              {p.methods.map((m) => (
                <label key={m} className="pr-option" data-checked={m === p.method}>
                  <input
                    type="radio"
                    name="merge-method"
                    checked={m === p.method}
                    disabled={p.busy}
                    onChange={() => p.onMethod(m)}
                  />
                  <span>
                    <strong>{mergeLabel(m)}</strong>
                    <small>{METHOD_HELP[m]}</small>
                  </span>
                </label>
              ))}
            </div>
            <h5>After merging</h5>
            <div className="pr-switch-row">
              <span>
                <strong id="delete-branch-label">Delete branch</strong>
                <small>Removes <code>{p.head}</code> from GitHub.</small>
              </span>
              <button
                role="switch"
                aria-checked={p.deleteBranch}
                aria-labelledby="delete-branch-label"
                className="pr-switch"
                disabled={p.busy}
                onClick={() => p.onDeleteBranch(!p.deleteBranch)}
              />
            </div>
          </div>
        </Popover>
      )}
    </footer>
  );
}
