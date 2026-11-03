import { useState } from "react";
import { commands } from "./bindings";
import { patchLine, type ReviewTarget } from "./codeOpen";
import { invalidateQueries } from "./queryCache";
import { commentsPrefix } from "./LineComments";
import { pullRequestCommentsPrefix } from "./reviewKeys";

interface Props {
  projectId: number;
  /** The path of the file the patch is about. */
  path: string;
  /** The patch document being read, and the line of it the cursor is on (1-based). */
  patch: string;
  line: number;
  review: ReviewTarget;
  onClose: () => void;
}

/** Writes a draft Line comment on the patch line under the cursor. */
export function CommentComposer({ projectId, path, patch, line, review, onClose }: Props) {
  const target = patchLine(patch, line);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!target || body.trim() === "") return;
    const comment = { path, side: target.side, line: target.line, code: target.code, body: body.trim() };
    const result =
      review.kind === "thread"
        ? await commands.addLineComment(review.threadId, { scope: review.scope, ...comment })
        : await commands.addPullRequestLineComment(projectId, review.pullRequest, comment);
    if (result.status === "error") return setError(result.error.message);
    invalidateQueries(review.kind === "thread" ? commentsPrefix(projectId) : pullRequestCommentsPrefix(projectId));
    onClose();
  }

  if (!target) {
    return (
      <div className="comment-form" role="group" aria-label="Comment on line">
        <span>Move the cursor to a changed or context line to comment on it.</span>
        <div className="line-comment-actions">
          <button type="button" className="btn sm" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="comment-form"
      aria-label="Comment on line"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="comment-form-where">
        <span className="mono">
          {path}:{target.line}
        </span>
        {target.side === "old" && <span className="chip">removed line</span>}
      </div>
      <pre className="comment-form-code mono">{target.code}</pre>
      <textarea
        autoFocus
        aria-label="Comment"
        placeholder={
          review.kind === "pullRequest"
            ? "Review comment (Cmd/Ctrl+Enter to add, Esc to cancel)"
            : "Comment for the agent (Cmd/Ctrl+Enter to add, Esc to cancel)"
        }
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="line-comment-actions">
        <button type="submit" className="btn primary sm" disabled={body.trim() === ""}>
          Add comment
        </button>
        <button type="button" className="btn sm" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
