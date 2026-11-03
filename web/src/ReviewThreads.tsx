import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CommentDiscussionIcon } from "@primer/octicons-react";
import type { Diff, PullRequestReviewThread } from "./bindings";
import { groupReviewThreads, type ThreadLine } from "./reviewThreadPlacement";

interface Props {
  diff: Diff;
  threads: PullRequestReviewThread[];
}

/** GitHub's inline review threads, on the lines of the pull request diff they were written on. */
export function ReviewThreads({ diff, threads }: Props) {
  // A resolved thread starts collapsed; the user can open or close any of them.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  if (threads.length === 0) return null;
  const groups = groupReviewThreads(diff, threads);
  const isOpen = (thread: PullRequestReviewThread) => toggled.get(thread.id) ?? !thread.resolved;
  const toggle = (thread: PullRequestReviewThread) =>
    setToggled((previous) => new Map(previous).set(thread.id, !isOpen(thread)));
  const open = threads.filter((thread) => !thread.resolved).length;

  const lines = (items: ThreadLine[]) => (
    <ul className="review-thread-lines">
      {items.map((line) => (
        <li key={`${line.path}\u0000${line.line ?? ""}\u0000${line.side ?? ""}`} className="review-thread-line">
          <div className="review-thread-where">
            <span className="mono">
              {line.path}
              {line.line !== null ? `:${line.line}` : ""}
            </span>
            {line.side === "old" && <span className="chip">removed line</span>}
          </div>
          {line.code && <pre className="review-thread-code mono">{line.code}</pre>}
          <ul className="review-thread-list">
            {line.threads.map((thread) => {
              const expanded = isOpen(thread);
              const author = thread.comments[0]?.author;
              return (
                <li key={thread.id} className={`review-thread${thread.resolved ? " resolved" : ""}${thread.outdated ? " outdated" : ""}`}>
                  <button
                    type="button"
                    className="review-thread-summary"
                    aria-expanded={expanded}
                    aria-label={`${thread.resolved ? "Resolved" : "Open"} review thread${author ? ` by ${author}` : ""}`}
                    onClick={() => toggle(thread)}
                  >
                    {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    {author && <span className="review-thread-author">@{author}</span>}
                    <span className="review-thread-count">
                      {thread.comments.length} comment{thread.comments.length === 1 ? "" : "s"}
                    </span>
                    {thread.resolved && <span className="chip resolved">Resolved</span>}
                    {thread.outdated && (
                      <span className="chip warn" title="This line has changed since the thread was written.">
                        Outdated
                      </span>
                    )}
                  </button>
                  {expanded && (
                    <ul className="review-thread-comments">
                      {thread.comments.map((comment, index) => (
                        <li key={`${thread.id}:${index}`} className="review-thread-comment">
                          <span className="review-thread-author">@{comment.author}</span>
                          <p className="review-thread-body">{comment.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="review-threads" aria-label="Review threads">
      <header className="review-threads-head">
        <CommentDiscussionIcon size={14} />
        <strong>
          {threads.length} review thread{threads.length === 1 ? "" : "s"}
        </strong>
        {open === 0 && <span className="chip resolved">All resolved</span>}
      </header>
      {groups.inDiff.length > 0 && lines(groups.inDiff)}
      {groups.notInDiff.length > 0 && (
        <section className="review-threads-lost" aria-label="Review threads not in this diff">
          <h4>Not in this diff</h4>
          <p className="review-threads-note">These threads point at lines this diff no longer holds.</p>
          {lines(groups.notInDiff)}
        </section>
      )}
    </section>
  );
}
