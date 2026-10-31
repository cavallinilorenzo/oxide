import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { commands, type PullRequest } from "./bindings";
import { createPrBlockedReason } from "./gitAction";
import { describeCreatePrError } from "./createPullRequestError";
import { MarkdownEditor } from "./MarkdownEditor";

export function PullRequestCreate({
  projectId,
  threadId,
  onCancel,
  onCreated,
}: {
  projectId: number;
  /** The Thread whose checkout the pull request is opened from. */
  threadId: number | null;
  onCancel: () => void;
  onCreated: (pr: PullRequest) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [draft, setDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const git = await commands.gitStatus(projectId, threadId);
        if (!active) return;
        if (git.status === "error") throw new Error(git.error.message);
        setHead(git.data.branch ?? "detached HEAD");
        const reason = createPrBlockedReason(git.data);
        setBlocked(reason);
        if (reason) return;
        const [defaults, bases] = await Promise.all([
          commands.pullRequestDraft(projectId, threadId),
          commands.pullRequestBaseBranches(projectId),
        ]);
        if (!active) return;
        if (defaults.status === "error")
          throw new Error(defaults.error.message);
        if (bases.status === "error") throw new Error(bases.error.message);
        setTitle(defaults.data.title);
        setBody(defaults.data.body);
        setBase(defaults.data.base);
        setBranches([...new Set([defaults.data.base, ...bases.data])]);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, threadId, retry]);
  async function submit() {
    if (busy || loading || blocked || !title.trim() || !base || base === head)
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.createPullRequest(
        projectId,
        threadId,
        title.trim(),
        body,
        base,
        draft,
      );
      if (result.status === "error") setError(result.error.message);
      else onCreated(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const diagnostic = error ? describeCreatePrError(error, base) : null;
  return (
    <form
      className="pr-create"
      aria-label="Create pull request"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="pr-compose-heading">
        <button
          type="button"
          className="icon-btn sm"
          disabled={busy}
          onClick={onCancel}
          aria-label="Back to pull requests"
        >
          <ArrowLeftIcon size={16} />
        </button>
        <h2>New pull request</h2>
      </header>
      {loading ? (
        <p role="status">Preparing your branch…</p>
      ) : blocked ? (
        <p role="status">{blocked}</p>
      ) : (
        <>
          <div className="pr-compose-branches">
            <GitBranchIcon size={14} />
            <span className="mono" title={head}>
              {head}
            </span>
            <ArrowRightIcon size={14} />
            <label>
              Base{" "}
              <select
                aria-label="Base branch"
                value={base}
                disabled={busy}
                onChange={(e) => setBase(e.target.value)}
              >
                {branches
                  .filter((b) => b !== head)
                  .map((b) => (
                    <option key={b}>{b}</option>
                  ))}
              </select>
            </label>
          </div>
          <label className="pr-create-title">
            Title
            <input
              autoFocus
              required
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What does this change?"
            />
          </label>
          <MarkdownEditor
            label="Description"
            value={body}
            onChange={setBody}
            disabled={busy}
            placeholder="Describe the change and how you tested it."
            rows={9}
          />
          <label className="pr-create-draft">
            <input
              type="checkbox"
              checked={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.checked)}
            />{" "}
            Create as draft
          </label>
          <p className="dim">
            Your branch will be pushed before the pull request is created.
          </p>
          <button
            className="btn primary"
            type="submit"
            disabled={busy || !title.trim() || !base || base === head}
          >
            {busy ? (
              <SyncIcon size={14} className="spin" />
            ) : (
              <GitPullRequestIcon size={14} />
            )}
            {busy
              ? "Creating…"
              : draft
                ? "Create draft pull request"
                : "Create pull request"}
          </button>
        </>
      )}
      {diagnostic && (
        <div role="alert" className="pr-create-error">
          <strong>{diagnostic.title}</strong>
          <p>{diagnostic.guidance}</p>
          <details>
            <summary>Details</summary>
            <pre>{error}</pre>
          </details>
          {!base && (
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                setRetry((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </form>
  );
}
