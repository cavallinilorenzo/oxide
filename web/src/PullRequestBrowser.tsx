import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircleFillIcon,
  ChevronDownIcon,
  CommentIcon,
  DotFillIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  LinkExternalIcon,
  SearchIcon,
  XCircleFillIcon,
} from "@primer/octicons-react";
import { useEffect, useState } from "react";
import {
  commands,
  type GitStatus,
  type MergeMethod,
  type PullRequest,
  type PullRequestCheck,
  type PullRequestDetail,
} from "./bindings";
import { Markdown } from "./PullRequestMarkdown";
import {
  countChecks,
  dedupeChecks,
  defaultMergeMethod,
  mergeLabel,
  readiness,
  relativeTime,
} from "./pullRequestReview";

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

export function PullRequestStateIcon({ draft, size = 16 }: { draft: boolean; size?: number }) {
  return draft ? (
    <GitPullRequestDraftIcon size={size} className="pr-state-draft" />
  ) : (
    <GitPullRequestIcon size={size} className="pr-state-open" />
  );
}

function Branches({ head, base }: { head: string; base: string }) {
  return (
    <span className="pr-branches" title={`${head} → ${base}`}>
      <span className="pr-branch">{head}</span>
      <ArrowRightIcon size={12} />
      <span className="pr-branch">{base}</span>
    </span>
  );
}

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
        <label className="pr-search-field">
          <SearchIcon size={14} />
          <input
            aria-label="Search pull requests"
            placeholder="Search pull requests"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="pr-chip"
          aria-pressed={mine}
          title="Only pull requests you opened"
          onClick={() => setMine((m) => !m)}
        >
          Mine
        </button>
      </form>
      <div className="pr-scroll">
        {list.state === "loading" && <p className="pr-empty">Loading…</p>}
        {list.state === "error" && (
          <p role="alert" className="pr-empty error">
            {list.message}
          </p>
        )}
        {list.state === "ready" && list.prs.length === 0 && (
          <p className="pr-empty">{search || mine ? "No pull requests match." : "No open pull requests."}</p>
        )}
        {list.state === "ready" && list.prs.length > 0 && (
          <ul className="pr-list" aria-label="Open pull requests">
            {list.prs.map((pr) => (
              <li key={pr.number}>
                <button className="pr-row" onClick={() => setOpened(pr.number)}>
                  <PullRequestStateIcon draft={pr.draft} />
                  <span className="pr-row-body">
                    <span className="pr-row-title">{pr.title}</span>
                    <span className="pr-row-meta">
                      <span>#{pr.number}</span>
                      <span aria-hidden>·</span>
                      <span className="pr-row-author">{pr.author}</span>
                      {pr.draft && <span className="pr-tag">Draft</span>}
                    </span>
                    <Branches head={pr.head} base={pr.base} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
  /** Absent when the pull request is the branch's own: there is no list to go back to. */
  onBack?: () => void;
  onChanged: () => void;
  onReviewFiles: (number: number) => void;
  /** Opens the pull request on GitHub; only offered for the branch's own. */
  onOpenOnGithub?: () => void;
}

export function PullRequestReview({
  projectId,
  number,
  refreshKey,
  onBack,
  onChanged,
  onReviewFiles,
  onOpenOnGithub,
}: PullRequestReviewProps) {
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

  const nav = (
    <div className="pr-nav">
      {onBack ? (
        <button className="pr-back" onClick={onBack}>
          <ArrowLeftIcon size={14} /> Pull requests
        </button>
      ) : (
        <span className="pr-nav-title">This branch</span>
      )}
      <span className="grow" />
      {onOpenOnGithub && (
        <button className="icon-btn sm" onClick={onOpenOnGithub} title="Open on GitHub" aria-label="Open on GitHub">
          <LinkExternalIcon size={14} />
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

  const { detail, git } = loaded;
  const pr = detail.pullRequest;
  const status = readiness(detail.checks, pr.draft);
  const canMerge = !pr.draft && method !== null && !busy;

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
      {nav}
      <div className="pr-scroll">
        <header className="pr-hero">
          <h3 className="pr-title">
            {pr.title} <span className="pr-number">#{pr.number}</span>
          </h3>
          <div className="pr-hero-meta">
            <span className={`pr-status ${merged ? "merged" : pr.draft ? "draft" : "open"}`}>
              {merged ? <GitMergeIcon size={14} /> : <PullRequestStateIcon draft={pr.draft} size={14} />}
              {merged ? "Merged" : pr.draft ? "Draft" : "Open"}
            </span>
            <span className="pr-row-author">{pr.author}</span>
          </div>
          <Branches head={pr.head} base={pr.base} />
        </header>

        <div className="pr-actions">
          <button className="primary" onClick={() => onReviewFiles(number)}>
            <FileDiffIcon size={14} /> Review files
            <span className="pr-count">{detail.diff.files.length}</span>
          </button>
          <button
            disabled={busy || git.pickerDisabledReason !== null}
            title={git.pickerDisabledReason ?? "Check this branch out in the main checkout"}
            onClick={() => void checkout()}
          >
            Check out
          </button>
        </div>
        {git.pickerDisabledReason && <p className="pr-note">{git.pickerDisabledReason}</p>}

        {detail.body.trim() && <Description body={detail.body} />}
        <Checks checks={detail.checks} />

        <section className="pr-section" aria-label="Conversation">
          <h4>
            <CommentIcon size={14} /> Conversation
            {detail.comments.length > 0 && <span className="pr-count">{detail.comments.length}</span>}
          </h4>
          {detail.comments.map((c, i) => (
            <article key={i} className="pr-comment">
              <header>
                <strong>{c.author}</strong>
                <time dateTime={c.createdAt}>{relativeTime(c.createdAt)}</time>
              </header>
              <Markdown source={c.body} />
            </article>
          ))}
          <form
            className="pr-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void sendComment();
            }}
          >
            <textarea
              aria-label="Comment"
              placeholder="Leave a comment"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {comment.trim() && (
              <button type="submit" disabled={busy} title="Send (⌘↩)">
                Comment
              </button>
            )}
          </form>
        </section>
        {error && (
          <p role="alert" className="pr-error">
            {error}
          </p>
        )}
      </div>

      <footer className="pr-merge" aria-label="Merge">
        {merged ? (
          <p className="pr-merge-status ok">
            <CheckCircleFillIcon size={14} /> Merged
          </p>
        ) : method === null ? (
          <p className="pr-merge-status">This repository allows no merge method.</p>
        ) : (
          <>
            <p className={`pr-merge-status ${status.tone}`}>
              <StatusIcon tone={status.tone} />
              {status.label}
            </p>
            <div className="pr-merge-row">
              <div className="pr-split">
                <button
                  className={`primary${status.tone === "bad" ? " risky" : ""}`}
                  disabled={!canMerge}
                  onClick={() => void merge()}
                >
                  <GitMergeIcon size={14} /> {mergeLabel(method)}
                </button>
                {detail.mergeMethods.length > 1 && (
                  <span className="pr-split-pick">
                    <ChevronDownIcon size={14} />
                    <select
                      aria-label="Merge method"
                      value={method}
                      disabled={busy}
                      onChange={(e) => setMethod(e.target.value as MergeMethod)}
                    >
                      {detail.mergeMethods.map((m) => (
                        <option key={m} value={m}>
                          {mergeLabel(m)}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
              </div>
              <label className="pr-check-opt">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
                Delete branch
              </label>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}

function StatusIcon({ tone }: { tone: "ok" | "warn" | "bad" | "neutral" }) {
  if (tone === "ok") return <CheckCircleFillIcon size={14} />;
  if (tone === "bad") return <XCircleFillIcon size={14} />;
  return <DotFillIcon size={14} />;
}

/** The description, clamped: bot and template boilerplate shouldn't push the rest off the screen. */
function Description({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const long = body.length > 320 || body.split("\n").length > 8;
  return (
    <section className="pr-section" aria-label="Description">
      <div className={`pr-desc${long && !open ? " clamped" : ""}`}>
        <Markdown source={body} />
      </div>
      {long && (
        <button className="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}

/** Checks, triaged: what needs attention is listed, what passed is one line you can open. */
function Checks({ checks }: { checks: PullRequestCheck[] }) {
  const { failing, pending, passing } = countChecks(checks);
  const all = dedupeChecks(checks);
  const attention = all.filter((c) => c.state !== "success");
  const passed = all.filter((c) => c.state === "success");
  if (all.length === 0) return null;
  return (
    <section className="pr-section" aria-label="Checks">
      <h4>
        Checks
        <span className="pr-bar" role="img" aria-label={`${failing} failing, ${pending} running, ${passing} passing`}>
          {failing > 0 && <i className="failure" style={{ flexGrow: failing }} />}
          {pending > 0 && <i className="pending" style={{ flexGrow: pending }} />}
          {passing > 0 && <i className="success" style={{ flexGrow: passing }} />}
        </span>
      </h4>
      {attention.length > 0 && (
        <ul className="pr-checks">
          {attention.map((c) => (
            <CheckRow key={c.name} check={c} />
          ))}
        </ul>
      )}
      {passed.length > 0 &&
        (attention.length === 0 && passed.length <= 3 ? (
          <ul className="pr-checks">
            {passed.map((c) => (
              <CheckRow key={c.name} check={c} />
            ))}
          </ul>
        ) : (
          <details className="pr-passed">
            <summary>
              <CheckCircleFillIcon size={14} className="pr-check-success" />
              {attention.length > 0 ? `${passed.length} passed` : `All ${passed.length} passed`}
              <ChevronDownIcon size={14} className="pr-chev" />
            </summary>
            <ul className="pr-checks">
              {passed.map((c) => (
                <CheckRow key={c.name} check={c} />
              ))}
            </ul>
          </details>
        ))}
    </section>
  );
}

const CHECK_WORD = { success: "Passed", failure: "Failed", pending: "Running" } as const;

function CheckRow({ check }: { check: PullRequestCheck }) {
  return (
    <li className={`pr-check pr-check-${check.state}`}>
      {check.state === "success" ? (
        <CheckCircleFillIcon size={14} />
      ) : check.state === "failure" ? (
        <XCircleFillIcon size={14} />
      ) : (
        <DotFillIcon size={14} className="pr-pulse" />
      )}
      <span className="pr-check-name">{check.name}</span>
      <span className="pr-check-state">{CHECK_WORD[check.state]}</span>
    </li>
  );
}
