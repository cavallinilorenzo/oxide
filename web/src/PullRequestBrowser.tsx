import { ArrowLeftIcon, CheckIcon, DotFillIcon, XIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import {
  commands,
  type GitStatus,
  type MergeMethod,
  type PullRequest,
  type PullRequestDetail,
} from "./bindings";
import { defaultMergeMethod, mergeLabel, summarizeChecks } from "./pullRequestReview";

interface PullRequestBrowserProps {
  projectId: number;
  /** Changes after the user's own Git changes, which reload the list. */
  refreshKey: number;
  /** Called after a checkout or merge, so other Git views reload. */
  onChanged: () => void;
  /** Shows the pull request's changed files in the Diff Surface. */
  onReviewFiles: (number: number) => void;
}

type List = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; prs: PullRequest[] };

/** Open pull requests of the repository: list, search, and one pull request to review. */
export function PullRequestBrowser({ projectId, refreshKey, onChanged, onReviewFiles }: PullRequestBrowserProps) {
  const [mine, setMine] = useState(false);
  const [query, setQuery] = useState("");
  // Sent on submit, not per keystroke: every search is a `gh` call.
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(0);
  const [list, setList] = useState<List>({ state: "loading" });
  const [opened, setOpened] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void commands.listPullRequests(projectId, mine, search).then((result) => {
      if (!active) return;
      setList(
        result.status === "ok"
          ? { state: "ready", prs: result.data }
          : { state: "error", message: result.error.message },
      );
    });
    return () => {
      active = false;
    };
  }, [projectId, mine, search, refreshKey, manual]);

  if (opened !== null) {
    return (
      <PullRequestReview
        projectId={projectId}
        number={opened}
        refreshKey={refreshKey}
        onBack={() => {
          setOpened(null);
          setManual((n) => n + 1);
        }}
        onChanged={onChanged}
        onReviewFiles={onReviewFiles}
      />
    );
  }

  return (
    <div className="pr-browser">
      <form
        className="pr-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query.trim());
        }}
      >
        <input
          aria-label="Search pull requests"
          placeholder="Search pull requests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine
        </label>
        <button type="button" onClick={() => setManual((n) => n + 1)} title="Reload from GitHub">
          Refresh
        </button>
      </form>
      {list.state === "loading" && <p className="pr-guidance">Loading…</p>}
      {list.state === "error" && <p role="alert">{list.message}</p>}
      {list.state === "ready" && list.prs.length === 0 && <p className="pr-guidance">No open pull requests.</p>}
      {list.state === "ready" && (
        <ul className="pr-list" aria-label="Open pull requests">
          {list.prs.map((pr) => (
            <li key={pr.number}>
              <button className="pr-row" onClick={() => setOpened(pr.number)}>
                <span className="pr-row-title">
                  #{pr.number} {pr.title}
                  {pr.draft && <span className="badge">draft</span>}
                </span>
                <span className="pr-row-meta">
                  {pr.author} · {pr.head} → {pr.base}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; detail: PullRequestDetail; git: GitStatus };

interface PullRequestReviewProps {
  projectId: number;
  number: number;
  refreshKey: number;
  onBack: () => void;
  onChanged: () => void;
  onReviewFiles: (number: number) => void;
}

function PullRequestReview({ projectId, number, refreshKey, onBack, onChanged, onReviewFiles }: PullRequestReviewProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [merged, setMerged] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [detail, git] = await Promise.all([
        commands.pullRequestDetail(projectId, number),
        commands.gitStatus(projectId),
      ]);
      if (!active) return;
      if (detail.status === "error") return setLoaded({ state: "error", message: detail.error.message });
      if (git.status === "error") return setLoaded({ state: "error", message: git.error.message });
      setLoaded({ state: "ready", detail: detail.data, git: git.data });
      setMethod((current) => defaultMergeMethod(detail.data.mergeMethods, current));
      setDeleteBranch(detail.data.deleteBranchOnMerge);
    })();
    return () => {
      active = false;
    };
  }, [projectId, number, refreshKey, reload]);

  const back = (
    <button className="pr-back" onClick={onBack}>
      <ArrowLeftIcon size={14} /> Pull requests
    </button>
  );
  if (loaded.state === "loading") return <div className="pr-review">{back}</div>;
  if (loaded.state === "error") {
    return (
      <div className="pr-review">
        {back}
        <p role="alert">{loaded.message}</p>
      </div>
    );
  }

  const { detail, git } = loaded;
  const pr = detail.pullRequest;

  async function act(run: () => Promise<{ status: "ok" } | { status: "error"; error: { message: string } }>) {
    setBusy(true);
    setError(null);
    const result = await run();
    setBusy(false);
    if (result.status === "error") setError(result.error.message);
    return result.status === "ok";
  }

  async function sendComment() {
    if (await act(() => commands.commentPullRequest(projectId, number, comment))) {
      setComment("");
      setReload((n) => n + 1);
    }
  }

  async function merge() {
    if (method === null) return;
    if (await act(() => commands.mergePullRequest(projectId, number, method, deleteBranch))) {
      setMerged(true);
      onChanged();
    }
  }

  async function checkout() {
    if (await act(() => commands.checkoutPullRequest(projectId, number))) onChanged();
  }

  return (
    <div className="pr-review">
      {back}
      <h3>
        #{pr.number} {pr.title}
        {pr.draft && <span className="badge">draft</span>}
      </h3>
      <p>
        {pr.author} · {pr.head} → {pr.base}
      </p>
      <div className="pr-actions">
        <button onClick={() => onReviewFiles(number)}>
          Review files ({detail.diff.files.length})
        </button>
        <button
          disabled={busy || git.pickerDisabledReason !== null}
          title={git.pickerDisabledReason ?? "Check this branch out in the main checkout"}
          onClick={() => void checkout()}
        >
          Check out locally
        </button>
      </div>
      {git.pickerDisabledReason && <p className="pr-guidance">{git.pickerDisabledReason}</p>}
      {detail.body.trim() && <pre className="pr-body">{detail.body}</pre>}

      <section aria-label="Checks">
        <h4>Checks · {summarizeChecks(detail.checks)}</h4>
        <ul className="pr-checks">
          {detail.checks.map((check, i) => (
            <li key={`${i}:${check.name}`} className={`pr-check pr-check-${check.state}`}>
              <span aria-hidden>{check.state === "success" ? <CheckIcon size={12} /> : check.state === "failure" ? <XIcon size={12} /> : <DotFillIcon size={12} />}</span>{" "}
              {check.name} <span className="pr-check-state">{check.state}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Conversation">
        <h4>Conversation</h4>
        {detail.comments.length === 0 && <p className="pr-guidance">No comments yet.</p>}
        {detail.comments.map((c, i) => (
          <article key={i} className="pr-comment">
            <header>{c.author}</header>
            <pre>{c.body}</pre>
          </article>
        ))}
        <form
          className="pr-form"
          onSubmit={(e) => {
            e.preventDefault();
            void sendComment();
          }}
        >
          <textarea
            aria-label="Comment"
            placeholder="Leave a comment"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <button type="submit" disabled={busy || !comment.trim()}>
            Comment
          </button>
        </form>
      </section>

      <section aria-label="Merge">
        <h4>Merge</h4>
        {merged ? (
          <p>Merged.</p>
        ) : method === null ? (
          <p className="pr-guidance">This repository allows no merge method.</p>
        ) : (
          <form
            className="pr-form"
            onSubmit={(e) => {
              e.preventDefault();
              void merge();
            }}
          >
            <select
              aria-label="Merge method"
              value={method}
              onChange={(e) => setMethod(e.target.value as MergeMethod)}
            >
              {detail.mergeMethods.map((m) => (
                <option key={m} value={m}>
                  {mergeLabel(m)}
                </option>
              ))}
            </select>
            <label>
              <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />{" "}
              Delete branch
            </label>
            <button type="submit" disabled={busy}>
              {mergeLabel(method)}
            </button>
          </form>
        )}
      </section>
      {error && (
        <p role="alert" className="git-error-text">
          {error}
        </p>
      )}
    </div>
  );
}
