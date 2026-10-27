import { shortcutLabel } from "./shortcuts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  CommentIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  MarkGithubIcon,
  SearchIcon,
} from "@primer/octicons-react";
import { useEffect, useState } from "react";
import {
  commands,
  type GitStatus,
  type MergeMethod,
  type PullRequest,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestEdit,
} from "./bindings";
import { Avatar } from "./Avatar";
import { Checks } from "./PullRequestChecks";
import { Markdown } from "./PullRequestMarkdown";
import { MergeFooter, MergeStatus } from "./PullRequestMerge";
import { NO_EDIT, PullRequestPeople, ReviewStateIcon } from "./PullRequestPeople";
import { defaultMergeMethod, mergeRequirements, readiness, relativeTime } from "./pullRequestReview";

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
          title={`Only pull requests you opened`}
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
                      <Avatar login={pr.author} size={16} />
                      <span className="pr-row-author">{pr.author}</span>
                      <span aria-hidden>·</span>
                      <span>#{pr.number}</span>
                      {pr.createdAt && (
                        <>
                          <span aria-hidden>·</span>
                          <time dateTime={pr.createdAt}>{relativeTime(pr.createdAt)}</time>
                        </>
                      )}
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
}

type Outcome = { status: "ok" } | { status: "error"; error: { message: string } };

export function PullRequestReview({
  projectId,
  number,
  refreshKey,
  onBack,
  onChanged,
  onReviewFiles,
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
      setMethod((current) => defaultMergeMethod(detail.data.mergeMethods, current, detail.data.defaultMergeMethod));
      // Only the repository's own preference seeds it: later reloads keep what the user chose.
      setDeleteBranch((current) => (current ? current : detail.data.deleteBranchOnMerge));
    })();
    return () => {
      active = false;
    };
  }, [projectId, number, refreshKey, reload]);

  async function openLink(url: string) {
    const result = await commands.openLink(url);
    if (result.status === "error") setError(result.error.message);
  }

  const loadedPr = loaded.state === "ready" ? loaded.detail.pullRequest : null;
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
      {loadedPr && (
        <button
          className="pr-github"
          onClick={() => void openLink(loadedPr.url)}
          title="Open this pull request on GitHub"
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

  const { detail, git } = loaded;
  const pr = detail.pullRequest;
  const phase = merged ? "merged" : detail.phase;
  const live = phase === "open" || phase === "draft";
  const inputs = { phase, checks: detail.checks, mergeState: detail.mergeState, reviewDecision: detail.reviewDecision ?? null };
  const status = readiness(inputs);
  const requirements = live ? mergeRequirements(inputs) : [];
  // GitHub reports "blocked" while required checks run or a review is missing, and the merge would be refused.
  const mergeBlocked = ["conflicting", "blocked", "behind"].includes(detail.mergeState);
  const canMerge = phase === "open" && method !== null && !busy && !mergeBlocked;

  async function act(run: () => Promise<Outcome>) {
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

  /** Runs a change to the pull request on GitHub, then shows its new state. */
  async function change(run: () => Promise<Outcome>) {
    const ok = await act(run);
    if (ok) setReload((n) => n + 1);
    return ok;
  }

  const setDraft = (draft: boolean) => change(() => commands.setPullRequestDraft(projectId, number, draft));
  const edit = (partial: Partial<PullRequestEdit>) =>
    change(() => commands.editPullRequest(projectId, number, { ...NO_EDIT, ...partial }));

  return (
    <div className="pr-review">
      {nav}
      <div className="pr-scroll">
        <header className="pr-hero">
          <h3 className="pr-title">
            {pr.title} <span className="pr-number">#{pr.number}</span>
          </h3>
          <div className="pr-hero-meta">
            <span className={`pr-status ${phase}`}>
              {phase === "merged" ? (
                <GitMergeIcon size={14} />
              ) : phase === "closed" ? (
                <GitPullRequestClosedIcon size={14} />
              ) : (
                <PullRequestStateIcon draft={phase === "draft"} size={14} />
              )}
              {{ merged: "Merged", closed: "Closed", draft: "Draft", open: "Open" }[phase]}
            </span>
            <Avatar login={pr.author} size={20} />
            <span className="pr-row-author">
              <strong>{pr.author}</strong>
              {pr.createdAt && <> opened {relativeTime(pr.createdAt)} ago</>}
            </span>
          </div>
          <Branches head={pr.head} base={pr.base} />
          {(detail.additions > 0 || detail.deletions > 0) && (
            <p className="pr-diffstat" aria-label={`${detail.additions} additions, ${detail.deletions} deletions`}>
              <span className="add">+{detail.additions}</span> <span className="del">−{detail.deletions}</span>
              <span className="pr-diffstat-files">
                {" "}
                in {detail.diff.files.length} {detail.diff.files.length === 1 ? "file" : "files"}
              </span>
            </p>
          )}
        </header>

        <div className="pr-actions">
          <button className="primary" onClick={() => onReviewFiles(number)}>
            <FileDiffIcon size={14} /> Review files
            <span className="pr-count">{detail.diff.files.length}</span>
          </button>
          {live && (
            <button
              disabled={busy || git.pickerDisabledReason !== null}
              title={git.pickerDisabledReason ?? "Check this branch out in the main checkout"}
              onClick={() => void checkout()}
            >
              Check out
            </button>
          )}
        </div>
        {live && git.pickerDisabledReason && <p className="pr-note">{git.pickerDisabledReason}</p>}

        {detail.body.trim() && <Description body={detail.body} />}
        {live && <MergeStatus requirements={requirements} busy={busy} onUpdateBranch={() => void change(() => commands.updatePullRequestBranch(projectId, number))} />}
        <Checks checks={detail.checks} onOpen={(url) => void openLink(url)} />
        <PullRequestPeople
          projectId={projectId}
          detail={detail}
          editable={live}
          busy={busy}
          onEdit={edit}
          onConvertToDraft={() => void setDraft(true)}
        />

        <section className="pr-section" aria-label="Conversation">
          <h4>
            <CommentIcon size={14} /> Conversation
            {detail.comments.length > 0 && <span className="pr-count">{detail.comments.length}</span>}
          </h4>
          {detail.comments.map((c, i) => (
            <Entry key={i} entry={c} author={pr.author} />
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
                disabled={busy || !comment.trim()}
                title={`Send (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
              >
                Comment
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

      {live || merged ? (
        <MergeFooter
          draft={phase === "draft"}
          merged={merged}
          methods={detail.mergeMethods}
          method={method}
          head={pr.head}
          deleteBranch={deleteBranch}
          busy={busy}
          canMerge={canMerge}
          tone={status.tone}
          status={status.label}
          onMethod={setMethod}
          onDeleteBranch={setDeleteBranch}
          onMerge={() => void merge()}
          onReady={() => void setDraft(false)}
        />
      ) : (
        <footer className="pr-merge" aria-label="Merge">
          <p className="pr-merge-status">
            {phase === "merged" ? "This pull request was merged." : "This pull request is closed."}
          </p>
        </footer>
      )}
    </div>
  );
}

const REVIEW_ACTION = {
  approved: "approved these changes",
  changesRequested: "requested changes",
  commented: "reviewed",
  dismissed: "had a review dismissed",
  requested: "was asked to review",
} as const;

/** One conversation entry as the web shows it: who, what they did, when, and what they wrote. */
function Entry({ entry, author }: { entry: PullRequestComment; author: string }) {
  return (
    <article className={`pr-entry${entry.review ? ` pr-entry-${entry.review}` : ""}`}>
      <Avatar login={entry.author} size={24} />
      <div className="pr-entry-card">
        <header>
          <strong>{entry.author}</strong>
          {entry.author === author && <span className="pr-tag">Author</span>}
          <span className="pr-entry-action">
            {entry.review ? (
              <>
                <ReviewStateIcon state={entry.review} size={12} /> {REVIEW_ACTION[entry.review]}
              </>
            ) : (
              "commented"
            )}
          </span>
          <time dateTime={entry.createdAt}>{relativeTime(entry.createdAt)}</time>
        </header>
        {entry.body.trim() && <Markdown source={entry.body} />}
      </div>
    </article>
  );
}

/** The description, folded away until asked for: bot and template boilerplate shouldn't
 *  push the rest off the screen, and when opened it is the whole text. */
function Description({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="pr-section pr-description" aria-label="Description">
      <button className="pr-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <h4>Description</h4>
        <ChevronDownIcon size={14} className="pr-chev" />
      </button>
      {open && <Markdown source={body} />}
    </section>
  );
}
