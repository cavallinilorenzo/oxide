import { useEffect, useMemo, useState } from "react";
import { GitBranchIcon } from "@primer/octicons-react";
import { Channel } from "@tauri-apps/api/core";
import { commands, type ApprovalDecision, type BoardCard, type BoardEvent, type Thread } from "./bindings";
import { DispatchDialog } from "./DispatchDialog";
import { applyBoardEvent, groupBoard, mergeCard, pullRequestSummary, suggestsDelete } from "./board";
import { threadTitle } from "./threadList";

interface BoardViewProps {
  projectId: number;
  onOpenThread: (threadId: number) => void;
  onDeleteThread: (threadId: number) => void;
  /** A task was dispatched: the new Thread, for the sidebar. */
  onDispatched: (thread: Thread) => void;
}

/** The Project's Thread Board: derived from Thread rows, so it only ever mirrors the feed. Mount per Project (`key`). */
export function BoardView({ projectId, onOpenThread, onDeleteThread, onDispatched }: BoardViewProps) {
  const [cards, setCards] = useState<BoardCard[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

  useEffect(() => {
    let active = true;
    const channel = new Channel<BoardEvent>();
    channel.onmessage = (event) => {
      if (active) setCards((previous) => applyBoardEvent(previous ?? [], event));
    };
    void commands.subscribeBoard(projectId, channel).then((res) => {
      if (!active) return;
      if (res.status === "ok") {
        // Events that raced ahead of the snapshot are newer: keep them.
        setCards((previous) => res.data.reduce(mergeCard, previous ?? []));
      } else setError(res.error.message);
    });
    return () => {
      active = false;
      // Dropping the channel ends the backend's forwarding the next time it sends.
      channel.onmessage = () => {};
    };
  }, [projectId]);

  const columns = useMemo(() => groupBoard(cards ?? [], query), [cards, query]);

  const respond = async (threadId: number, approvalId: string, decision: ApprovalDecision) => {
    const res = await commands.respondToApproval(threadId, approvalId, decision);
    setError(res.status === "error" ? res.error.message : null);
  };
  const stop = async (threadId: number) => {
    const res = await commands.interruptThread(threadId);
    setError(res.status === "error" ? res.error.message : null);
  };

  const render = (title: string, list: BoardCard[]) => (
    <section className="board-column" aria-label={title}>
      <h3 className="board-column-title">
        {title} <span className="board-count">{list.length}</span>
      </h3>
      <ul className="board-cards">
        {list.map((card) => (
          <BoardCardView
            key={card.thread.id}
            card={card}
            onOpen={() => onOpenThread(card.thread.id)}
            onStop={() => void stop(card.thread.id)}
            onDelete={() => onDeleteThread(card.thread.id)}
            onRespond={(approvalId, decision) => void respond(card.thread.id, approvalId, decision)}
          />
        ))}
      </ul>
    </section>
  );

  return (
    <main className="centre board" aria-label="Thread Board">
      <div className="board-toolbar">
        <input
          type="search"
          className="thread-search"
          placeholder="Search Threads"
          aria-label="Search Board by title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => setDispatching(true)}>Dispatch</button>
      </div>
      <SetupCommandEditor projectId={projectId} />
      {dispatching && (
        <DispatchDialog
          projectId={projectId}
          onClose={() => setDispatching(false)}
          onDispatched={(thread) => {
            setDispatching(false);
            onDispatched(thread);
          }}
        />
      )}
      {error && <p className="error">{error}</p>}
      {cards === null ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="board-columns">
          {render("Needs input", columns.needsInput)}
          {render("Working", columns.working)}
          {render("Completed", columns.completed)}
        </div>
      )}
    </main>
  );
}

function BoardCardView({
  card,
  onOpen,
  onStop,
  onDelete,
  onRespond,
}: {
  card: BoardCard;
  onOpen: () => void;
  onStop: () => void;
  onDelete: () => void;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
}) {
  const { thread } = card;
  const running = thread.status === "working" || thread.status === "needs-input";
  const summary = pullRequestSummary(card.pullRequest);
  return (
    <li className="board-card" aria-label={threadTitle(thread)}>
      <div className="board-card-head">
        <span className={`status-dot ${thread.status}`} aria-hidden="true" />
        <button className="board-card-title" onClick={onOpen} title="Open Thread">
          {threadTitle(thread)}
        </button>
        {thread.branch && (
          <span className="board-card-branch" title={thread.branch}>
            <GitBranchIcon size={12} /> {thread.branch}
          </span>
        )}
        {(thread.status === "error" || thread.status === "interrupted") && (
          <span className={`badge board-badge ${thread.status}`}>{thread.status}</span>
        )}
      </div>
      {card.pendingApprovals.map((approval) => (
        <div className="board-approval" key={approval.approvalId} aria-label="Approval">
          <span className="approval-kind-badge">{approval.kind}</span>
          <div className="approval-summary">{approval.summary}</div>
          <div className="approval-actions">
            <button type="button" className="approval-btn allow" onClick={() => onRespond(approval.approvalId, "allow")}>
              Allow
            </button>
            <button type="button" className="approval-btn deny" onClick={() => onRespond(approval.approvalId, "deny")}>
              Deny
            </button>
            {approval.options.map((option) => (
              <button
                key={option}
                type="button"
                className="approval-btn option"
                onClick={() => onRespond(approval.approvalId, "allow")}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}
      {summary && (
        <div className={`board-pr ${card.pullRequest?.phase}`} aria-label="Pull request">
          <span>{summary}</span>
          {card.pullRequest && card.pullRequest.checksFailed > 0 && <span className="board-pr-failing">failing</span>}
        </div>
      )}
      {suggestsDelete(card) && (
        <div className="board-delete-suggestion">
          <span>This pull request was merged.</span>
          <button onClick={onDelete}>Delete Thread</button>
        </div>
      )}
      <div className="board-card-actions">
        <button onClick={onOpen}>Open</button>
        {running && <button onClick={onStop}>Stop</button>}
        <button onClick={onDelete}>Delete</button>
      </div>
    </li>
  );
}

/** The Project's Setup command: kept by Oxide, run in every new worktree, never written to the repository. */
function SetupCommandEditor({ projectId }: { projectId: number }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void commands.getProjectSetupCommand(projectId).then((res) => {
      if (!active) return;
      if (res.status === "ok") {
        setSaved(res.data);
        setText(res.data ?? "");
      } else setError(res.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  const save = async () => {
    const res = await commands.setProjectSetupCommand(projectId, text.trim() || null);
    if (res.status === "ok") {
      setSaved(text.trim() || null);
      setError(null);
    } else setError(res.error.message);
  };

  return (
    <details className="setup-command">
      <summary>Setup command{saved ? "" : " (none)"}</summary>
      <p className="hint">
        Runs in each new worktree before its first Turn, with <code>$OXIDE_PROJECT_ROOT</code> pointing at the main
        checkout. Stored by Oxide, not in the repository.
      </p>
      <input
        aria-label="Setup command"
        placeholder="cp $OXIDE_PROJECT_ROOT/.env . && npm install"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
      <button onClick={() => void save()} disabled={text.trim() === (saved ?? "")}>
        Save
      </button>
      {error && <p className="error">{error}</p>}
    </details>
  );
}
