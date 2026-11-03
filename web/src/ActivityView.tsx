import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  LightBulbIcon,
  SearchIcon,
  TerminalIcon,
  ToolsIcon,
  XCircleIcon,
} from "@primer/octicons-react";
import {
  PHASE_LABELS,
  failedCommandCount,
  failedCommandsIn,
  formatElapsed,
  isFailedCommand,
  statusPhrase,
  summaryText,
  type Activity,
  type ActivityItem,
  type LiveCategory,
  type LiveStatus,
  type Phase,
  type PhaseKind,
} from "./activity";
import type { ItemSnapshot } from "./bindings";
import { useOpenDiff } from "./diffOpen";
import { splitHeadline } from "./transcriptView";

/** How often the live phrase moves on within one kind of work. */
const ROTATE_MS = 2500;

const PHASE_ICONS: Record<PhaseKind, React.ReactNode> = {
  reasoning: <LightBulbIcon size={12} />,
  explore: <SearchIcon size={12} />,
  edit: <FileDiffIcon size={12} />,
  run: <TerminalIcon size={12} />,
  delegate: <CommentDiscussionIcon size={12} />,
  other: <ToolsIcon size={12} />,
};

function Disclosure({
  open,
  onToggle,
  className,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={className} aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      {children}
    </button>
  );
}

function failedLabel(count: number): string {
  return count === 1 ? "Failed" : `${count} failed`;
}

function failedAriaLabel(count: number): string {
  return `${count} failed ${count === 1 ? "command" : "commands"}`;
}

function FailedMark({ count, label }: { count: number; label: string }) {
  return (
    <span className="activity-failed" title={label} aria-label={label}>
      <XCircleIcon size={12} />
      {failedLabel(count)}
    </span>
  );
}

function ChildItem({ item }: { item: ItemSnapshot }) {
  const { headline, detail } = splitHeadline(item.content);
  const failed = isFailedCommand(item);
  return (
    <div className={`activity-child${failed ? " activity-child-failed" : ""}`}>
      <div className="activity-child-head">
        {headline}
        {failed && <FailedMark count={1} label={failedAriaLabel(1)} />}
      </div>
      {detail && <pre className="tool-detail">{detail}</pre>}
    </div>
  );
}

function ItemRow({ entry, kind }: { entry: ActivityItem; kind: PhaseKind }) {
  const openDiff = useOpenDiff();
  const [open, setOpen] = useState(false);
  const { item, children } = entry;
  const { headline, detail } = splitHeadline(item.content);
  const failed = isFailedCommand(item);
  const failedChildren = children.filter(isFailedCommand).length;

  if (item.kind === "file_change" || kind === "edit") {
    return (
      <button
        type="button"
        className="activity-item activity-item-file"
        onClick={() => openDiff(headline)}
        aria-label={`Open diff for ${headline}`}
      >
        <FileDiffIcon size={12} />
        <span className="activity-item-text">{headline}</span>
      </button>
    );
  }

  if (kind === "reasoning") {
    return <div className="reasoning-text">{item.content}</div>;
  }

  const expandable = detail !== "" || children.length > 0;
  if (!expandable) {
    return (
      <div
        className={`activity-item activity-item-plain${failed ? " activity-item-failed" : ""}`}
      >
        <span className="activity-item-text">{headline}</span>
        {(failed || failedChildren > 0) && (
          <FailedMark count={failed ? 1 : failedChildren} label={failedAriaLabel(failed ? 1 : failedChildren)} />
        )}
      </div>
    );
  }
  return (
    <div className="activity-item-group">
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className={`activity-item${failed ? " activity-item-failed" : ""}`}
      >
        <span className="activity-item-text">{headline}</span>
        {(failed || failedChildren > 0) && (
          <FailedMark count={failed ? 1 : failedChildren} label={failedAriaLabel(failed ? 1 : failedChildren)} />
        )}
      </Disclosure>
      {open && (
        <div className="activity-item-body">
          {detail && <pre className="tool-detail">{detail}</pre>}
          {children.map((child) => (
            <ChildItem key={child.id || child.itemIndex} item={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseRow({ phase }: { phase: Phase }) {
  const [open, setOpen] = useState(false);
  const count = phase.items.length;
  const failed = failedCommandsIn(phase.items);
  return (
    <div className="activity-phase">
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        className={`activity-phase-toggle${failed > 0 ? " activity-phase-failed" : ""}`}
      >
        {PHASE_ICONS[phase.kind]}
        <span className="collapsible-label">{PHASE_LABELS[phase.kind]}</span>
        {failed > 0 && (
          <FailedMark
            count={failed}
            label={failedAriaLabel(failed)}
          />
        )}
        {phase.kind !== "reasoning" && <span className="activity-count">{count}</span>}
      </Disclosure>
      {open && (
        <div className="rail">
          {phase.items.map((entry) => (
            <ItemRow key={entry.item.id || entry.item.itemIndex} entry={entry} kind={phase.kind} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The phrase of one kind of work; mounted afresh per kind so its pool restarts from the top. */
function Phrase({ category }: { category: LiveCategory }) {
  const [rotation, setRotation] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setRotation((r) => r + 1), ROTATE_MS);
    return () => window.clearInterval(id);
  }, []);
  return <span className="activity-live-phrase">{statusPhrase(category, rotation)}…</span>;
}

/** The live line of a running Turn: an animated phrase, the latest target, and a timer. */
function LiveLine({ status, startedAt }: { status: LiveStatus; startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const started = Date.parse(startedAt);
  const elapsed = Number.isNaN(started) ? 0 : now - started;
  return (
    <div className="activity-live">
      <span className="activity-live-dot" aria-hidden />
      <div className="activity-live-main">
        <Phrase key={status.category} category={status.category} />
        {status.subline && <span className="activity-live-sub">{status.subline}</span>}
      </div>
      <span className="activity-live-timer">{formatElapsed(elapsed)}</span>
      {/* Announced on a change of kind only, never on rotation or every tick. */}
      <span className="sr-only" role="status" aria-live="polite">
        {statusPhrase(status.category, 0)}
      </span>
    </div>
  );
}

export function ActivityView({
  activity,
  live,
  waiting,
  startedAt,
  workedMs,
}: {
  activity: Activity | null;
  /** Set while the Turn runs and is not waiting on an Approval. */
  live: LiveStatus | null;
  /** The Turn is paused on an Approval: it needs the user, it is not working. */
  waiting: boolean;
  startedAt: string;
  /** How long the Turn took, once it has ended. */
  workedMs: number | null;
}) {
  const [open, setOpen] = useState(false);
  const failed = failedCommandCount(activity);
  return (
    <div className="activity">
      {live && <LiveLine status={live} startedAt={startedAt} />}
      {waiting && (
        <div className="activity-live activity-waiting" role="status">
          <span className="activity-live-dot" aria-hidden />
          <span className="activity-live-phrase">Waiting for your approval</span>
        </div>
      )}
      {activity && (
        <div className="activity-summary">
          <Disclosure
            open={open}
            onToggle={() => setOpen((v) => !v)}
            className={`activity-summary-toggle${failed > 0 ? " activity-summary-failed" : ""}`}
          >
            <span className="collapsible-label">{summaryText(activity)}</span>
            {failed > 0 && (
              <FailedMark
                count={failed}
                label={failedAriaLabel(failed)}
              />
            )}
            {!live && !waiting && workedMs !== null && (
              <span className="activity-worked">Worked for {formatElapsed(workedMs)}</span>
            )}
          </Disclosure>
          {open && (
            <div className="activity-phases">
              {activity.phases.map((phase, i) => (
                <PhaseRow key={i} phase={phase} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
