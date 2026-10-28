import {
  ArrowLeftIcon,
  ChevronDownIcon,
  CommentIcon,
  MarkGithubIcon,
  PencilIcon,
  PlayIcon,
} from "@primer/octicons-react";
import { useEffect, useRef, useState } from "react";
import {
  commands,
  type IssueCloseReason,
  type IssueDetail,
  type IssueEdit,
} from "./bindings";
import { Avatar } from "./Avatar";
import { DispatchDialog } from "./DispatchDialog";
import { IssueStateIcon } from "./IssueStateIcon";
import { canSubmitComment, ISSUE_PHASE_LABEL, issuePhase, titleChanged } from "./issueView";
import { Popover } from "./Popover";
import { Markdown } from "./PullRequestMarkdown";
import { Working } from "./PullRequestMerge";
import { Field, LabelChip, Picker, useCandidates } from "./PullRequestPeople";
import { relativeTime } from "./pullRequestReview";
import { shortcutLabel } from "./shortcuts";
import type { Thread } from "./bindings";
import type { DispatchIssue } from "./dispatch";

interface IssueDetailViewProps {
  projectId: number;
  number: number;
  /** Changes whenever the issue should be fetched again. */
  refreshKey: number;
  onBack: () => void;
  /** Called after the issue changed on GitHub, so the list reloads. */
  onChanged: () => void;
  onDispatched?: (thread: Thread) => void;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; issue: IssueDetail };

/** The action in flight: its button keeps its colour and shows a spinner; the others wait. */
type Pending = "comment" | "close" | "reopen" | "edit";
type Result = { status: "ok" } | { status: "error"; error: { message: string } };

const NO_EDIT: IssueEdit = {
  title: null,
  body: null,
  addAssignees: [],
  removeAssignees: [],
  addLabels: [],
  removeLabels: [],
};

const REASONS: { reason: IssueCloseReason; title: string; help: string }[] = [
  { reason: "completed", title: "Close as completed", help: "Done, closed, fixed, resolved" },
  { reason: "notPlanned", title: "Close as not planned", help: "Won't fix, can't repro, duplicate, stale" },
];

// The pill colours are the pull request ones: completed reads like merged, not planned like draft.
const PILL = { open: "open", completed: "merged", notPlanned: "draft" } as const;

/** One issue, with what the web page lets you do: read and edit it, assign and label it,
 *  discuss it, close it with a reason or reopen it, and start a Thread from it. */
export function IssueDetailView({ projectId, number, refreshKey, onBack, onChanged, onDispatched }: IssueDetailViewProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState<IssueCloseReason>("completed");
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [starting, setStarting] = useState<DispatchIssue | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonTrigger = useRef<HTMLButtonElement>(null);
  const { candidates, load } = useCandidates(projectId);
  const busy = pending !== null;

  useEffect(() => {
    let active = true;
    void commands.issueDetail(projectId, number).then((result) => {
      if (!active) return;
      setLoaded(
        result.status === "ok"
          ? { state: "ready", issue: result.data }
          : { state: "error", message: result.error.message },
      );
    });
    return () => {
      active = false;
    };
  }, [projectId, number, refreshKey, reload]);

  async function openLink(url: string) {
    const result = await commands.openLink(url);
    if (result.status === "error") setError(result.error.message);
  }

  const issue = loaded.state === "ready" ? loaded.issue : null;
  const nav = (
    <div className="pr-nav">
      <button className="pr-back" onClick={onBack}>
        <ArrowLeftIcon size={14} /> Issues
      </button>
      <span className="grow" />
      {issue && (
        <button
          className="pr-github"
          onClick={() => void openLink(issue.url)}
          title="Open this issue on GitHub"
          aria-label="Open on GitHub"
        >
          <MarkGithubIcon size={16} />
        </button>
      )}
    </div>
  );
  if (loaded.state === "loading") {
    return (
      <div className="pr-review" aria-busy>
        {nav}
        <p className="pr-empty">Loading…</p>
      </div>
    );
  }
  if (loaded.state === "error") {
    return (
      <div className="pr-review">
        {nav}
        <p role="alert" className="pr-empty error">
          {loaded.message}
        </p>
      </div>
    );
  }

  const { issue: detail } = loaded;
  const phase = issuePhase(detail);
  const open = phase === "open";

  /** Runs a change on GitHub, then shows the issue's new state. */
  async function change(kind: Pending, run: () => Promise<Result>) {
    setPending(kind);
    setError(null);
    const result = await run();
    setPending(null);
    if (result.status === "error") {
      setError(result.error.message);
      return false;
    }
    setReload((n) => n + 1);
    onChanged();
    return true;
  }

  const edit = (partial: Partial<IssueEdit>) =>
    change("edit", () => commands.editIssue(projectId, number, { ...NO_EDIT, ...partial }));

  async function saveTitle() {
    if (titleDraft === null) return;
    if (!titleChanged(detail.title, titleDraft) || (await edit({ title: titleDraft.trim() }))) setTitleDraft(null);
  }

  async function saveBody() {
    if (bodyDraft === null) return;
    if (bodyDraft === detail.body || (await edit({ body: bodyDraft }))) setBodyDraft(null);
  }

  async function sendComment() {
    if (await change("comment", () => commands.commentIssue(projectId, number, comment))) setComment("");
  }

  async function close() {
    // A comment left in the box goes out with the close, as the web's "Close with comment" does.
    if (await change("close", () => commands.closeIssue(projectId, number, reason, comment))) setComment("");
  }

  const startable = onDispatched && open;

  return (
    <div className="pr-review">
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
      {nav}
      <div className="pr-scroll">
        <header className="pr-hero">
          {titleDraft === null ? (
            <h3 className="pr-title">
              {detail.title} <span className="pr-number">#{detail.number}</span>
              <button
                className="icon-btn sm issue-edit"
                aria-label="Edit title"
                title="Edit title"
                disabled={busy}
                onClick={() => setTitleDraft(detail.title)}
              >
                <PencilIcon size={14} />
              </button>
            </h3>
          ) : (
            <form
              className="issue-title-edit"
              onSubmit={(e) => {
                e.preventDefault();
                void saveTitle();
              }}
            >
              <input
                aria-label="Title"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setTitleDraft(null)}
              />
              <button
                type="submit"
                className={`primary${pending === "edit" ? " pending" : ""}`}
                disabled={busy || titleDraft.trim() === ""}
              >
                <Working on={pending === "edit"} label="Saving…">
                  Save
                </Working>
              </button>
              <button type="button" onClick={() => setTitleDraft(null)} disabled={busy}>
                Cancel
              </button>
            </form>
          )}
          <div className="pr-hero-meta">
            <span className={`pr-status ${PILL[phase]}`}>
              <IssueStateIcon phase={phase} size={14} />
              {ISSUE_PHASE_LABEL[phase]}
            </span>
            <Avatar login={detail.author} size={20} />
            <span className="pr-row-author">
              <strong>{detail.author}</strong>
              {detail.createdAt && <> opened {relativeTime(detail.createdAt)} ago</>}
            </span>
          </div>
        </header>

        {startable && (
          <div className="pr-actions">
            <button
              className="primary"
              onClick={() =>
                setStarting({ number: detail.number, title: detail.title, body: detail.body, url: detail.url })
              }
            >
              <PlayIcon size={14} /> Start thread from issue
            </button>
          </div>
        )}

        <section className="pr-section" aria-label="Description">
          <article className="pr-entry">
            <Avatar login={detail.author} size={24} />
            <div className="pr-entry-card">
              <header>
                <strong>{detail.author}</strong>
                <span className="pr-tag">Author</span>
                <span className="pr-entry-action">wrote</span>
                {bodyDraft === null && (
                  <button
                    className="icon-btn sm issue-edit"
                    aria-label="Edit description"
                    title="Edit description"
                    disabled={busy}
                    onClick={() => setBodyDraft(detail.body)}
                  >
                    <PencilIcon size={14} />
                  </button>
                )}
              </header>
              {bodyDraft === null ? (
                detail.body.trim() ? (
                  <Markdown source={detail.body} />
                ) : (
                  <p className="pr-field-empty issue-no-body">No description provided.</p>
                )
              ) : (
                <div className="issue-body-edit">
                  <textarea
                    aria-label="Description"
                    rows={8}
                    value={bodyDraft}
                    autoFocus
                    onChange={(e) => setBodyDraft(e.target.value)}
                  />
                  <div className="pr-merge-row">
                    <button
                      className={`primary${pending === "edit" ? " pending" : ""}`}
                      disabled={busy}
                      onClick={() => void saveBody()}
                    >
                      <Working on={pending === "edit"} label="Saving…">
                        Save
                      </Working>
                    </button>
                    <button onClick={() => setBodyDraft(null)} disabled={busy}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </article>
        </section>

        <section className="pr-section pr-details" aria-label="Details">
          <Field
            title="Assignees"
            editable
            picker={(closePicker) => (
              <Picker
                title="Assign up to 10 people"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.users.map((u) => ({ key: u, label: u, login: u }))}
                selected={detail.assignees}
                busy={busy}
                onToggle={(key, on) => edit(on ? { addAssignees: [key] } : { removeAssignees: [key] })}
                onClose={closePicker}
              />
            )}
          >
            {detail.assignees.length === 0 ? (
              <p className="pr-field-empty">
                No one
                {detail.viewer && (
                  <>
                    {" – "}
                    <button className="link" disabled={busy} onClick={() => void edit({ addAssignees: [detail.viewer] })}>
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
            editable
            picker={(closePicker) => (
              <Picker
                title="Apply labels"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.labels.map((l) => ({ key: l.name, label: l.name, color: l.color }))}
                selected={detail.labels.map((l) => l.name)}
                busy={busy}
                onToggle={(key, on) => edit(on ? { addLabels: [key] } : { removeLabels: [key] })}
                onClose={closePicker}
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

        <section className="pr-section" aria-label="Conversation">
          <h4>
            <CommentIcon size={14} /> Conversation
            {detail.comments.length > 0 && <span className="pr-count">{detail.comments.length}</span>}
          </h4>
          {detail.comments.map((c, i) => (
            <article key={i} className="pr-entry">
              <Avatar login={c.author} size={24} />
              <div className="pr-entry-card">
                <header>
                  <strong>{c.author}</strong>
                  {c.author === detail.author && <span className="pr-tag">Author</span>}
                  <span className="pr-entry-action">commented</span>
                  <time dateTime={c.createdAt}>{relativeTime(c.createdAt)}</time>
                </header>
                {c.body.trim() && <Markdown source={c.body} />}
              </div>
            </article>
          ))}
          <form
            className="pr-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void sendComment();
            }}
          >
            {detail.viewer && <Avatar login={detail.viewer} size={24} />}
            <div className="pr-compose-box">
              <textarea
                aria-label="Comment"
                placeholder="Leave a comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                type="submit"
                className={pending === "comment" ? "pending" : undefined}
                disabled={busy || !canSubmitComment(comment)}
                title={`Send (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
              >
                <Working on={pending === "comment"} label="Commenting…">
                  Comment
                </Working>
              </button>
            </div>
          </form>
        </section>
        {error && (
          <p role="alert" className="pr-error">
            {error}
          </p>
        )}
      </div>

      <footer className="pr-merge" aria-label="Status">
        {open ? (
          <div className="pr-merge-row">
            <button
              className={`primary${pending === "close" ? " pending" : ""}`}
              disabled={busy}
              onClick={() => void close()}
            >
              <Working on={pending === "close"} label="Closing…">
                {canSubmitComment(comment) ? "Close with comment" : REASONS.find((r) => r.reason === reason)?.title}
              </Working>
            </button>
            <button
              ref={reasonTrigger}
              className="icon-btn"
              aria-label="Close reason"
              aria-haspopup="dialog"
              aria-expanded={reasonOpen}
              title="Close reason"
              onClick={() => setReasonOpen((o) => !o)}
            >
              <ChevronDownIcon size={16} />
            </button>
            {reasonOpen && (
              <Popover anchor={reasonTrigger} label="Close reason" onClose={() => setReasonOpen(false)} width={300}>
                <div className="pr-options">
                  <h5>Close reason</h5>
                  <div role="radiogroup" aria-label="Close reason">
                    {REASONS.map((r) => (
                      <label key={r.reason} className="pr-option" data-checked={r.reason === reason}>
                        <input
                          type="radio"
                          name="close-reason"
                          checked={r.reason === reason}
                          onChange={() => {
                            setReason(r.reason);
                            setReasonOpen(false);
                          }}
                        />
                        <span>
                          <strong>{r.title}</strong>
                          <small>{r.help}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </Popover>
            )}
          </div>
        ) : (
          <>
            <p className="pr-merge-status neutral">
              <IssueStateIcon phase={phase} size={14} />
              {phase === "notPlanned" ? "Closed as not planned" : "Closed as completed"}
            </p>
            <div className="pr-merge-row">
              <button
                className={pending === "reopen" ? "pending" : undefined}
                disabled={busy}
                onClick={() => void change("reopen", () => commands.reopenIssue(projectId, number))}
              >
                <Working on={pending === "reopen"} label="Reopening…">
                  Reopen issue
                </Working>
              </button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
