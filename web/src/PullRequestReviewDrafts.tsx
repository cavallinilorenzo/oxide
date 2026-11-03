import { useState } from "react";
import { CommentIcon, PaperAirplaneIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type PullRequestLineComment, type ReviewVerdict } from "./bindings";
import { LineCommentList } from "./LineCommentList";
import { invalidateQueries, useQuery, type QueryResult } from "./queryCache";
import { pullRequestCommentsPrefix, reviewThreadsPrefix } from "./reviewKeys";

interface Props {
  projectId: number;
  pullRequest: number;
  /** Changes when the pull request or the checkout does, so the drafts stay current. */
  refreshKey: string;
  /** Called once GitHub accepted the review, so the Pull request Surface reloads its decision. */
  onSubmitted: () => void;
}

/** The pull request's draft Line comments, and the one review that sends them (or just a decision). */
export function PullRequestReviewDrafts({ projectId, pullRequest, refreshKey, onSubmitted }: Props) {
  const query = useQuery(
    `${pullRequestCommentsPrefix(projectId)}${pullRequest}`,
    async (): Promise<QueryResult<PullRequestLineComment[]>> =>
      commands.listPullRequestLineComments(projectId, pullRequest),
    refreshKey,
  );
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState<ReviewVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const comments = query.state === "ready" ? (query.data ?? []) : [];

  const refresh = () => invalidateQueries(pullRequestCommentsPrefix(projectId));
  async function run(action: () => Promise<{ status: "ok" } | { status: "error"; error: { message: string } }>) {
    setError(null);
    const result = await action();
    if (result.status === "error") setError(result.error.message);
    else refresh();
    return result.status === "ok";
  }

  async function submit(verdict: ReviewVerdict) {
    setSubmitting(verdict);
    setError(null);
    const result = await commands.submitPullRequestReview(projectId, pullRequest, verdict, summary.trim());
    setSubmitting(null);
    if (result.status === "error") return setError(result.error.message);
    // GitHub took every draft as one review: forget them, then show its threads and decision.
    setSummary("");
    invalidateQueries(pullRequestCommentsPrefix(projectId), { drop: true });
    invalidateQueries(reviewThreadsPrefix(projectId));
    onSubmitted();
  }

  const verdicts: { verdict: ReviewVerdict; label: string; className: string }[] = [
    { verdict: "comment", label: "Comment", className: "btn sm" },
    { verdict: "approve", label: "Approve", className: "btn primary sm" },
    { verdict: "requestChanges", label: "Request changes", className: "btn sm" },
  ];

  return (
    <section className="line-comments review-drafts" aria-label="Pull request review">
      <header className="line-comments-head">
        <CommentIcon size={14} />
        <strong>
          {comments.length > 0
            ? `${comments.length} draft comment${comments.length === 1 ? "" : "s"}`
            : "Review this pull request"}
        </strong>
        <span className="grow" />
        {comments.length > 0 && <span className="review-drafts-note">Sent to GitHub with your review</span>}
      </header>
      {comments.length === 0 ? (
        <p className="surface-note">Comment on a line of the diff, or write a summary below.</p>
      ) : (
        <LineCommentList
          comments={comments}
          edit={(id, body) => run(() => commands.editPullRequestLineComment(id, body))}
          remove={(id) => run(() => commands.deletePullRequestLineComment(id))}
        />
      )}
      <form
        className="review-drafts-submit"
        aria-label="Submit review"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("comment");
        }}
      >
        <textarea
          aria-label="Review summary"
          placeholder="Review summary (required to request changes)"
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="line-comment-actions">
          {verdicts.map(({ verdict, label, className }) => (
            <button
              key={verdict}
              type="button"
              className={`${className}${submitting === verdict ? " pending" : ""}`}
              disabled={submitting !== null}
              onClick={() => void submit(verdict)}
            >
              {submitting === verdict ? (
                <>
                  <SyncIcon size={12} className="spin" /> Submitting…
                </>
              ) : verdict === "comment" ? (
                <>
                  <PaperAirplaneIcon size={12} /> {label}
                </>
              ) : (
                label
              )}
            </button>
          ))}
        </div>
      </form>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
