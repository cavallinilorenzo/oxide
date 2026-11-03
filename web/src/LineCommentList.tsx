import { useState } from "react";
import { PencilIcon, TrashIcon } from "@primer/octicons-react";
import type { CommentSide } from "./bindings";

/** The fields a draft Line comment shows, whether it will go to a Thread or to GitHub. */
export interface DraftLineComment {
  id: number;
  path: string;
  side: CommentSide;
  line: number;
  code: string;
  body: string;
  /** The line no longer holds the quoted code. */
  outdated?: boolean;
}

interface Props {
  comments: DraftLineComment[];
  /** Resolves once the parent has saved the edit or shown its error. */
  edit: (id: number, body: string) => Promise<boolean>;
  /** Resolves once the parent has deleted the draft or shown its error. */
  remove: (id: number) => Promise<boolean>;
}

/** Drafts with their line, quoted code and body, each one editable and deletable in place. */
export function LineCommentList({ comments, edit, remove }: Props) {
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  return (
    <ul className="line-comment-list">
      {comments.map((c) => (
        <li key={c.id} className={`line-comment${c.outdated ? " outdated" : ""}`}>
          <div className="line-comment-where">
            <span className="mono">
              {c.path}:{c.line}
            </span>
            {c.side === "old" && <span className="chip">removed line</span>}
            {c.outdated && (
              <span className="chip warn" title="This line has changed since you commented.">
                Outdated
              </span>
            )}
          </div>
          <pre className="line-comment-code mono">{c.code}</pre>
          {editing?.id === c.id ? (
            <form
              className="line-comment-edit"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing.body.trim() === "") return;
                void edit(c.id, editing.body).then((ok) => ok && setEditing(null));
              }}
            >
              <textarea
                autoFocus
                aria-label={`Edit comment on ${c.path} line ${c.line}`}
                rows={2}
                value={editing.body}
                onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                }}
              />
              <div className="line-comment-actions">
                <button type="submit" className="btn sm" disabled={editing.body.trim() === ""}>
                  Save
                </button>
                <button type="button" className="btn sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="line-comment-body">{c.body}</p>
              <div className="line-comment-actions">
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Edit comment on ${c.path} line ${c.line}`}
                  onClick={() => setEditing({ id: c.id, body: c.body })}
                >
                  <PencilIcon size={12} /> Edit
                </button>
                <button
                  type="button"
                  className="btn sm"
                  aria-label={`Delete comment on ${c.path} line ${c.line}`}
                  onClick={() => void remove(c.id)}
                >
                  <TrashIcon size={12} /> Delete
                </button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
