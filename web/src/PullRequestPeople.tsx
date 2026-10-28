import {
  CheckCircleFillIcon,
  CheckIcon,
  ClockIcon,
  CommentIcon,
  GearIcon,
  SkipIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getQueryData, setQueryData } from "./queryCache";
import { Avatar } from "./Avatar";
import {
  commands,
  type PullRequestCandidates,
  type PullRequestDetail,
  type PullRequestEdit,
  type PullRequestLabel,
  type ReviewState,
} from "./bindings";
import { Popover } from "./Popover";

export const NO_EDIT: PullRequestEdit = {
  addReviewers: [],
  removeReviewers: [],
  addAssignees: [],
  removeAssignees: [],
  addLabels: [],
  removeLabels: [],
};

interface PullRequestPeopleProps {
  projectId: number;
  detail: PullRequestDetail;
  /** False once the pull request is merged or closed: its settings are history. */
  editable: boolean;
  busy: boolean;
  /** Resolves true once GitHub took the change. */
  onEdit: (edit: Partial<PullRequestEdit>) => Promise<boolean>;
  onConvertToDraft: () => void;
}

export type Candidates =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: PullRequestCandidates };

/** The people and labels GitHub offers, fetched the first time a picker opens. */
export function useCandidates(projectId: number) {
  const key = `p${projectId}:candidates`;
  const cached = getQueryData<PullRequestCandidates>(key);
  const [candidates, setCandidates] = useState<Candidates>(
    cached ? { state: "ready", data: cached } : { state: "idle" },
  );
  const requested = useRef(false);
  const load = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setCandidates((current) => (current.state === "ready" ? current : { state: "loading" }));
    void commands.pullRequestCandidates(projectId).then((result) => {
      if (result.status === "error") requested.current = false;
      else setQueryData(key, result.data);
      setCandidates((current) =>
        result.status === "ok"
          ? { state: "ready", data: result.data }
          : current.state === "ready"
            ? current
            : { state: "error", message: result.error.message },
      );
    });
  }, [projectId, key]);
  return { candidates, load };
}

const REVIEW_WORD: Record<ReviewState, string> = {
  requested: "Awaiting review",
  approved: "Approved",
  changesRequested: "Requested changes",
  commented: "Commented",
  dismissed: "Review dismissed",
};

export function ReviewStateIcon({ state, size = 14 }: { state: ReviewState; size?: number }) {
  const props = { size, className: `pr-review-${state}`, "aria-label": REVIEW_WORD[state], title: REVIEW_WORD[state] };
  switch (state) {
    case "approved":
      return <CheckCircleFillIcon {...props} />;
    case "changesRequested":
      return <XCircleFillIcon {...props} />;
    case "commented":
      return <CommentIcon {...props} />;
    case "dismissed":
      return <SkipIcon {...props} />;
    default:
      return <ClockIcon {...props} />;
  }
}

const HEX = /^[0-9a-f]{6}$/i;

export function LabelChip({ label }: { label: PullRequestLabel }) {
  const color = HEX.test(label.color) ? `#${label.color}` : "#8994a9";
  return (
    <span className="pr-label" style={{ "--label": color } as CSSProperties}>
      {label.name}
    </span>
  );
}

/** The pull request's people and labels, with the same settings the web sidebar offers. */
export function PullRequestPeople({ projectId, detail, editable, busy, onEdit, onConvertToDraft }: PullRequestPeopleProps) {
  const { candidates, load } = useCandidates(projectId);
  const pr = detail.pullRequest;

  const reviewerPeople = detail.reviewers.map((r) => r.login);
  return (
    <section className="pr-section pr-details" aria-label="Details">
      <Field
        title="Reviewers"
        editable={editable}
        picker={(close) => (
          <Picker
            title="Request review from"
            candidates={candidates}
            onOpen={load}
            items={(c) =>
              c.users.filter((u) => u !== pr.author).map((u) => ({ key: u, label: u, login: u }))
            }
            selected={reviewerPeople}
            busy={busy}
            onToggle={(key, on) => onEdit(on ? { addReviewers: [key] } : { removeReviewers: [key] })}
            onClose={close}
          />
        )}
      >
        {detail.reviewers.length === 0 ? (
          <p className="pr-field-empty">No reviews</p>
        ) : (
          <ul className="pr-people">
            {detail.reviewers.map((r) => (
              <li key={r.login}>
                <Avatar login={r.login} size={18} />
                <span className="pr-person">{r.login}</span>
                <ReviewStateIcon state={r.state} />
              </li>
            ))}
          </ul>
        )}
        {editable && pr.draft === false && (
          <p className="pr-field-hint">
            Still in progress?{" "}
            <button className="link" onClick={onConvertToDraft} disabled={busy}>
              Convert to draft
            </button>
          </p>
        )}
      </Field>

      <Field
        title="Assignees"
        editable={editable}
        picker={(close) => (
          <Picker
            title="Assign up to 10 people"
            candidates={candidates}
            onOpen={load}
            items={(c) => c.users.map((u) => ({ key: u, label: u, login: u }))}
            selected={detail.assignees}
            busy={busy}
            onToggle={(key, on) => onEdit(on ? { addAssignees: [key] } : { removeAssignees: [key] })}
            onClose={close}
          />
        )}
      >
        {detail.assignees.length === 0 ? (
          <p className="pr-field-empty">
            No one
            {editable && detail.viewer && (
              <>
                {" – "}
                <button className="link" disabled={busy} onClick={() => void onEdit({ addAssignees: [detail.viewer] })}>
                  assign yourself
                </button>
              </>
            )}
          </p>
        ) : (
          <ul className="pr-people">
            {detail.assignees.map((login) => (
              <li key={login}>
                <Avatar login={login} size={18} />
                <span className="pr-person">{login}</span>
              </li>
            ))}
          </ul>
        )}
      </Field>

      <Field
        title="Labels"
        editable={editable}
        picker={(close) => (
          <Picker
            title="Apply labels"
            candidates={candidates}
            onOpen={load}
            items={(c) => c.labels.map((l) => ({ key: l.name, label: l.name, color: l.color }))}
            selected={detail.labels.map((l) => l.name)}
            busy={busy}
            onToggle={(key, on) => onEdit(on ? { addLabels: [key] } : { removeLabels: [key] })}
            onClose={close}
          />
        )}
      >
        {detail.labels.length === 0 ? (
          <p className="pr-field-empty">None yet</p>
        ) : (
          <div className="pr-labels">
            {detail.labels.map((l) => (
              <LabelChip key={l.name} label={l} />
            ))}
          </div>
        )}
      </Field>
    </section>
  );
}

export function Field({
  title,
  editable,
  picker,
  children,
}: {
  title: string;
  editable: boolean;
  picker: (close: () => void) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="pr-field">
      <div className="pr-field-head">
        <h5>{title}</h5>
        {editable && (
          <button
            ref={trigger}
            className="icon-btn sm"
            aria-label={`Edit ${title.toLowerCase()}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => setOpen((o) => !o)}
          >
            <GearIcon size={14} />
          </button>
        )}
      </div>
      {children}
      {open && (
        <Popover anchor={trigger} label={title} onClose={close}>
          {picker(close)}
        </Popover>
      )}
    </div>
  );
}

interface PickerItem {
  key: string;
  label: string;
  login?: string;
  color?: string;
}

export function Picker({
  title,
  candidates,
  onOpen,
  items,
  selected,
  busy,
  onToggle,
  onClose,
}: {
  title: string;
  candidates: Candidates;
  onOpen: () => void;
  items: (data: PullRequestCandidates) => PickerItem[];
  selected: string[];
  busy: boolean;
  onToggle: (key: string, on: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(onOpen, [onOpen]);
  const all = candidates.state === "ready" ? items(candidates.data) : [];
  // A reviewer GitHub reports but doesn't list as assignable (a team, say) stays removable.
  const known = new Set(all.map((i) => i.key));
  const extra: PickerItem[] = candidates.state === "ready" ? selected.filter((s) => !known.has(s)).map((s) => ({ key: s, label: s })) : [];
  const q = query.trim().toLowerCase();
  const shown = [...extra, ...all].filter((i) => i.label.toLowerCase().includes(q));
  return (
    <div className="pr-picker">
      <header>
        <strong>{title}</strong>
        <button className="link" onClick={onClose}>
          Done
        </button>
      </header>
      <input
        aria-label={`Filter: ${title}`}
        placeholder="Filter"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {candidates.state === "loading" && <p className="pr-field-empty">Loading from GitHub…</p>}
      {candidates.state === "error" && (
        <p role="alert" className="pr-error">
          {candidates.message}
        </p>
      )}
      {candidates.state === "ready" && shown.length === 0 && <p className="pr-field-empty">Nothing matches.</p>}
      <ul role="listbox" aria-multiselectable aria-label={title}>
        {shown.map((item) => {
          const on = selected.includes(item.key);
          return (
            <li key={item.key} role="option" aria-selected={on}>
              <button disabled={busy} onClick={() => void onToggle(item.key, !on)}>
                <span className="pr-picker-check">{on && <CheckIcon size={14} />}</span>
                {item.login !== undefined && <Avatar login={item.login} size={18} />}
                {item.color !== undefined && (
                  <span className="pr-swatch" style={{ background: HEX.test(item.color) ? `#${item.color}` : "#8994a9" }} />
                )}
                <span className="pr-person">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
