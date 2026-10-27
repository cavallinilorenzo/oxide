import { ArrowLeftIcon, CommentIcon } from "@primer/octicons-react";
import { useCallback, useEffect, useState } from "react";
import {
  commands,
  type IssueDetail,
  type IssuesState_Serialize,
  type IssueSummary,
  type Thread,
} from "./bindings";
import { DispatchDialog } from "./DispatchDialog";
import type { DispatchIssue } from "./dispatch";
import { canSubmitComment, canSubmitIssue, formatIssueLabel } from "./issueView";

export interface IssuesSurfaceProps {
  projectId: number;
  /** Changes after user mutations/actions that should refresh the surface. */
  refreshKey?: number;
  /** Called after issue mutations (create/close/comment), so parent views can react if needed. */
  onChanged?: () => void;
  /** A Thread was started from an issue: the new Thread, for the sidebar. */
  onDispatched?: (thread: Thread) => void;
}

type SurfaceState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "guidance"; guidance: string }
  | { state: "ready"; issuesState: IssuesState_Serialize };

export function IssuesSurface(props: IssuesSurfaceProps) {
  return <IssuesSurfaceBody key={props.projectId} {...props} />;
}

function IssuesSurfaceBody({ projectId, refreshKey = 0, onChanged, onDispatched }: IssuesSurfaceProps) {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>({ state: "loading" });
  const [openedIssue, setOpenedIssue] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [manual, setManual] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [search, setSearch] = useState("");

  const reloadSurface = useCallback(() => setManual((n) => n + 1), []);
  const reloadList = useCallback(() => setListRevision((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const state = await commands.issuesState(projectId);
      if (!active) return;
      if (state.status === "error") {
        setSurfaceState({ state: "error", message: state.error.message });
      } else if (state.data.availability !== "ready") {
        setSurfaceState({
          state: "guidance",
          guidance: state.data.guidance ?? "The GitHub CLI is not ready.",
        });
      } else {
        setSurfaceState({ state: "ready", issuesState: state.data });
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, refreshKey, manual]);

  const refreshButton = (
    <button className="pr-refresh" onClick={reloadSurface} title="Reload from GitHub">
      Refresh
    </button>
  );

  let content: React.ReactNode;

  if (surfaceState.state === "loading") {
    content = null;
  } else if (surfaceState.state === "error") {
    content = (
      <>
        <p role="alert">{surfaceState.message}</p>
        <div className="pr-actions">{refreshButton}</div>
      </>
    );
  } else if (surfaceState.state === "guidance") {
    content = (
      <>
        <p className="pr-guidance">{surfaceState.guidance}</p>
        <div className="pr-actions">{refreshButton}</div>
      </>
    );
  } else if (creating) {
    content = (
      <CreateIssueView
        projectId={projectId}
        onBack={() => setCreating(false)}
        onCreated={(created) => {
          reloadList();
          setCreating(false);
          setOpenedIssue(created.number);
          onChanged?.();
        }}
      />
    );
  } else if (openedIssue !== null) {
    content = (
      <IssueDetailView
        projectId={projectId}
        number={openedIssue}
        refreshKey={refreshKey}
        onBack={() => {
          setOpenedIssue(null);
          reloadList();
        }}
        onMutation={() => {
          reloadList();
          onChanged?.();
        }}
        onDispatched={onDispatched}
      />
    );
  } else {
    content = (
      <IssuesListView
        projectId={projectId}
        refreshKey={refreshKey}
        listRevision={listRevision}
        manualKey={manual}
        search={search}
        onSearchChange={setSearch}
        onSelectIssue={(num) => setOpenedIssue(num)}
        onStartCreate={() => setCreating(true)}
        onRefresh={() => {
          reloadSurface();
          reloadList();
        }}
      />
    );
  }

  return (
    <section className="pr-panel issues-surface" aria-label="Issues">
      {content}
    </section>
  );
}

interface IssuesListViewProps {
  projectId: number;
  refreshKey: number;
  listRevision: number;
  manualKey: number;
  search: string;
  onSearchChange: (search: string) => void;
  onSelectIssue: (number: number) => void;
  onStartCreate: () => void;
  onRefresh: () => void;
}

type ListState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; issues: IssueSummary[] };

function IssuesListView({
  projectId,
  refreshKey,
  listRevision,
  manualKey,
  search,
  onSearchChange,
  onSelectIssue,
  onStartCreate,
  onRefresh,
}: IssuesListViewProps) {
  const [query, setQuery] = useState(search);
  const [list, setList] = useState<ListState>({ state: "loading" });

  useEffect(() => {
    let active = true;
    void commands.listIssues(projectId, search).then((result) => {
      if (!active) return;
      if (result.status === "ok") {
        setList({ state: "ready", issues: result.data });
      } else {
        setList({ state: "error", message: result.error.message });
      }
    });
    return () => {
      active = false;
    };
  }, [projectId, search, refreshKey, listRevision, manualKey]);

  return (
    <div className="issues-browser">
      <div className="pr-actions" style={{ justifyContent: "space-between" }}>
        <button onClick={onStartCreate} title="Create a new issue">
          + New issue
        </button>
        <button onClick={onRefresh} title="Reload from GitHub">
          Refresh
        </button>
      </div>

      <form
        className="pr-search issues-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSearchChange(query.trim());
        }}
      >
        <input
          aria-label="Search issues"
          placeholder="Search issues"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit">Search</button>
      </form>

      {list.state === "loading" && <p className="pr-guidance">Loading issues…</p>}
      {list.state === "error" && <p role="alert">{list.message}</p>}
      {list.state === "ready" && list.issues.length === 0 && (
        <p className="pr-guidance">No issues found.</p>
      )}
      {list.state === "ready" && list.issues.length > 0 && (
        <ul className="pr-list issues-list" aria-label="Issue list">
          {list.issues.map((issue) => (
            <li key={issue.number}>
              <button
                className="pr-row issue-row"
                onClick={() => onSelectIssue(issue.number)}
              >
                <span className="pr-row-title">
                  {formatIssueLabel(issue)}
                  {issue.state === "CLOSED" && <span className="badge">closed</span>}
                </span>
                <span className="pr-row-meta issue-row-meta">
                  opened by {issue.author}
                  {issue.commentsCount > 0 && (
                    <>
                      {" · "}
                      <CommentIcon size={12} /> {issue.commentsCount}
                    </>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface CreateIssueViewProps {
  projectId: number;
  onBack: () => void;
  onCreated: (issue: IssueSummary) => void;
}

function CreateIssueView({ projectId, onBack, onCreated }: CreateIssueViewProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitIssue(title)) return;
    setBusy(true);
    setError(null);
    const result = await commands.createIssue(projectId, title.trim(), body.trim());
    setBusy(false);
    if (result.status === "ok") {
      onCreated(result.data);
    } else {
      setError(result.error.message);
    }
  }

  return (
    <div className="issue-create">
      <button className="pr-back issue-back" onClick={onBack}>
        <ArrowLeftIcon size={14} /> Issues
      </button>
      <h3>New issue</h3>
      <form className="pr-form" onSubmit={(e) => void handleSubmit(e)}>
        <input
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <textarea
          aria-label="Description"
          placeholder="Leave a comment or description"
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="pr-actions">
          <button type="submit" className={busy ? "pending" : undefined} disabled={busy || !canSubmitIssue(title)}>
            {busy ? "Creating…" : "Submit new issue"}
          </button>
          <button type="button" onClick={onBack} disabled={busy}>
            Cancel
          </button>
        </div>
        {error && (
          <p role="alert" className="git-error-text">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

interface IssueDetailViewProps {
  projectId: number;
  number: number;
  refreshKey: number;
  onBack: () => void;
  onMutation: () => void;
  onDispatched?: (thread: Thread) => void;
}

type DetailState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; issue: IssueDetail };

function IssueDetailView({
  projectId,
  number,
  refreshKey,
  onBack,
  onMutation,
  onDispatched,
}: IssueDetailViewProps) {
  const [detailState, setDetailState] = useState<DetailState>({ state: "loading" });
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localReload, setLocalReload] = useState(0);
  const [starting, setStarting] = useState<DispatchIssue | null>(null);

  const reloadDetail = useCallback(() => setLocalReload((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    void commands.issueDetail(projectId, number).then((result) => {
      if (!active) return;
      if (result.status === "ok") {
        setDetailState({ state: "ready", issue: result.data });
      } else {
        setDetailState({ state: "error", message: result.error.message });
      }
    });
    return () => {
      active = false;
    };
  }, [projectId, number, refreshKey, localReload]);

  async function handleOpenOnGithub() {
    setError(null);
    const result = await commands.openIssue(projectId, number);
    if (result.status === "error") setError(result.error.message);
  }

  async function handleCloseIssue() {
    setBusy(true);
    setError(null);
    const result = await commands.closeIssue(projectId, number);
    setBusy(false);
    if (result.status === "ok") {
      onMutation();
      reloadDetail();
    } else {
      setError(result.error.message);
    }
  }

  async function handleSendComment(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmitComment(commentText)) return;
    setBusy(true);
    setError(null);
    const result = await commands.commentIssue(projectId, number, commentText.trim());
    setBusy(false);
    if (result.status === "ok") {
      setCommentText("");
      onMutation();
      reloadDetail();
    } else {
      setError(result.error.message);
    }
  }

  const back = (
    <button className="pr-back issue-back" onClick={onBack}>
      <ArrowLeftIcon size={14} /> Issues
    </button>
  );

  if (detailState.state === "loading") {
    return <div className="issue-review">{back}</div>;
  }

  if (detailState.state === "error") {
    return (
      <div className="issue-review">
        {back}
        <p role="alert">{detailState.message}</p>
      </div>
    );
  }

  const { issue } = detailState;

  return (
    <div className="issue-review">
      {back}
      {starting && onDispatched && (
        <DispatchDialog
          projectId={projectId}
          issue={starting}
          onClose={() => setStarting(null)}
          onDispatched={(thread) => {
            setStarting(null);
            onDispatched(thread);
          }}
        />
      )}
      <h3>
        {formatIssueLabel(issue)}
        <span className="badge" style={{ marginLeft: 6 }}>
          {issue.state.toLowerCase()}
        </span>
      </h3>
      <p className="pr-row-meta">
        opened by {issue.author}
      </p>

      <div className="pr-actions">
        {onDispatched && issue.state === "OPEN" && (
          <button
            onClick={() => setStarting({ number: issue.number, title: issue.title, body: issue.body, url: issue.url })}
          >
            Start thread from issue
          </button>
        )}
        <button onClick={() => void handleOpenOnGithub()}>Open on GitHub</button>
        {issue.state === "OPEN" && (
          <button className={busy ? "pending" : undefined} onClick={() => void handleCloseIssue()} disabled={busy}>
            {busy ? "Closing…" : "Close issue"}
          </button>
        )}
        <button onClick={reloadDetail} title="Reload issue">
          Refresh
        </button>
      </div>

      {issue.body.trim() && <pre className="pr-body issue-body">{issue.body}</pre>}

      <section aria-label="Conversation">
        <h4>Conversation ({issue.comments.length})</h4>
        {issue.comments.length === 0 && (
          <p className="pr-guidance">No comments yet.</p>
        )}
        {issue.comments.map((c, i) => (
          <article key={i} className="pr-comment issue-comment">
            <header>{c.author}</header>
            <pre>{c.body}</pre>
          </article>
        ))}

        <form className="pr-form" onSubmit={(e) => void handleSendComment(e)}>
          <textarea
            aria-label="Comment"
            placeholder="Leave a comment"
            rows={3}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
          />
          <button type="submit" className={busy ? "pending" : undefined} disabled={busy || !canSubmitComment(commentText)}>
            {busy ? "Posting…" : "Comment"}
          </button>
        </form>
      </section>

      {error && (
        <p role="alert" className="git-error-text">
          {error}
        </p>
      )}
    </div>
  );
}
