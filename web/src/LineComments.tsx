import { useState } from "react";
import { CommentIcon, PaperAirplaneIcon } from "@primer/octicons-react";
import { commands, type LineComment } from "./bindings";
import { LineCommentList } from "./LineCommentList";
import { invalidateQueries, useQuery, type QueryResult } from "./queryCache";

/** Cache prefix of a Project's draft lists, so adding a comment elsewhere refreshes this one. */
export const commentsPrefix = (projectId: number) => `p${projectId}:comments:`;

interface Props {
  projectId: number;
  threadId: number;
  /** The Thread is running a Turn: drafts can be written but not sent. */
  working: boolean;
  /** Changes when the Thread or the checkout does, so outdated flags stay current. */
  refreshKey: string;
}

/** The Thread's draft Line comments, with edit, delete and one Send for all of them. */
export function LineComments({ projectId, threadId, working, refreshKey }: Props) {
  const query = useQuery(
    `${commentsPrefix(projectId)}${threadId}`,
    async (): Promise<QueryResult<LineComment[]>> => commands.listLineComments(threadId),
    refreshKey,
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const comments = query.state === "ready" ? (query.data ?? []) : [];
  if (comments.length === 0) return null;

  const refresh = () => invalidateQueries(commentsPrefix(projectId));
  async function run(action: () => Promise<{ status: "ok" } | { status: "error"; error: { message: string } }>) {
    setError(null);
    const result = await action();
    if (result.status === "error") setError(result.error.message);
    else refresh();
    return result.status === "ok";
  }
  async function send() {
    setSending(true);
    await run(() => commands.sendLineComments(threadId));
    setSending(false);
  }
  const outdated = comments.filter((c) => c.outdated).length;

  return (
    <section className="line-comments" aria-label="Line comments">
      <header className="line-comments-head">
        <CommentIcon size={14} />
        <strong>
          {comments.length} draft comment{comments.length === 1 ? "" : "s"}
        </strong>
        {outdated > 0 && <span className="chip warn">{outdated} outdated</span>}
        <span className="grow" />
        <button
          type="button"
          className={`btn primary sm${sending ? " pending" : ""}`}
          disabled={working || sending}
          title={working ? "Send when the Thread has finished its Turn" : "Send every draft to the Thread in one message"}
          onClick={() => void send()}
        >
          <PaperAirplaneIcon size={14} /> Send to Thread
        </button>
      </header>
      {working && <div className="surface-note">The Thread is working. Drafts are kept; send them when it finishes.</div>}
      <LineCommentList
        comments={comments}
        edit={(id, body) => run(() => commands.editLineComment(id, body))}
        remove={(id) => run(() => commands.deleteLineComment(id))}
      />
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
