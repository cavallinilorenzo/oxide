import { shortcutLabel } from "./shortcuts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowLeftIcon, GitBranchIcon, GitPullRequestIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type GitStatus, type PullRequestDraft, type PullRequestState } from "./bindings";
import { createPrBlockedReason } from "./gitAction";
import { PullRequestBrowser, PullRequestReview } from "./PullRequestBrowser";
import { PullRequestError } from "./PullRequestError";
import { describeCreatePrError } from "./createPullRequestError";

interface PullRequestPanelProps {
  projectId: number;
  /** Changes after the user's own Git changes (commit, push, pull, checkout), which refresh the panel. */
  refreshKey: number;
  /** Called after a pull request was created, merged or checked out, so other Git views reload. */
  onChanged: () => void;
  /** Shows a pull request's changed files in the Diff Surface. */
  onReviewFiles: (number: number) => void;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; pr: PullRequestState; git: GitStatus; draft: PullRequestDraft | null };

/** The branch's pull request on GitHub, through `gh`. It loads when opened and
 *  after the user's own Git changes or a manual refresh; it never polls.
 *  State belongs to one Project, so a different one remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestViews key={props.projectId} {...props} />;
}

const VIEWS = [
  { view: "branch", label: "This branch" },
  { view: "browse", label: "Open PRs" },
] as const;

function PullRequestViews(props: PullRequestPanelProps) {
  const [view, setView] = useState<(typeof VIEWS)[number]["view"]>("branch");
  // Bumped by the Refresh button: the only reload besides opening and the user's own changes.
  const [manual, setManual] = useState(0);
  const refresh = useCallback(() => setManual((n) => n + 1), []);
  return (
    <div className="pr-views">
      <div className="surface-bar">
        <div className="seg" role="tablist" aria-label="Pull request view">
          {VIEWS.map((v) => (
            <button key={v.view} role="tab" aria-selected={view === v.view} onClick={() => setView(v.view)}>
              {v.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="icon-btn sm" onClick={refresh} title={`Reload from GitHub`} aria-label="Reload from GitHub">
          <SyncIcon size={14} />
        </button>
      </div>
      {view === "branch" ? (
        <PullRequestBody {...props} manual={manual} onRefresh={refresh} />
      ) : (
        <section className="pr-panel pr-panel-flush" aria-label="Pull requests">
          <PullRequestBrowser {...props} refreshKey={props.refreshKey + manual} />
        </section>
      )}
    </div>
  );
}

function PullRequestBody({
  projectId,
  refreshKey,
  onChanged,
  onReviewFiles,
  manual,
  onRefresh,
}: PullRequestPanelProps & { manual: number; onRefresh: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Side by side: the draft only needs local Git once `gh` and the default branch are known.
      const [pr, git, draft] = await Promise.all([
        commands.pullRequestState(projectId),
        commands.gitStatus(projectId),
        commands.pullRequestDraft(projectId),
      ]);
      if (!active) return;
      if (pr.status === "error") setLoaded({ state: "error", message: pr.error.message });
      else if (git.status === "error") setLoaded({ state: "error", message: git.error.message });
      else setLoaded({ state: "ready", pr: pr.data, git: git.data, draft: draft.status === "ok" ? draft.data : null });
    })();
    return () => {
      active = false;
    };
  }, [projectId, refreshKey, manual]);

  async function openOnGithub() {
    setError(null);
    const result = await commands.openPullRequest(projectId);
    if (result.status === "error") setError(result.error.message);
  }

  if (loaded.state === "loading") {
    return (
      <section className="pr-panel" aria-label="Pull request" aria-busy>
        <p className="surface-empty">
          <SyncIcon size={14} className="spin" /> Loading from GitHub…
        </p>
      </section>
    );
  }
  if (loaded.state === "error") {
    return (
      <section className="pr-panel" aria-label="Pull request">
        <PullRequestError title="Couldn’t load the pull request" message={loaded.message} onRetry={onRefresh} />
      </section>
    );
  }

  const { pr, git, draft } = loaded;
  if (pr.availability !== "ready") {
    return (
      <section className="pr-panel" aria-label="Pull request">
        <p className="pr-guidance">{pr.guidance}</p>
      </section>
    );
  }

  const existing = pr.pullRequest;
  return (
    <section className={`pr-panel${existing ? " pr-panel-flush" : ""}`} aria-label="Pull request">
      {existing ? (
        <PullRequestReview
          projectId={projectId}
          number={existing.number}
          refreshKey={refreshKey + manual}
          onChanged={() => {
            onChanged();
            onRefresh();
          }}
          onReviewFiles={onReviewFiles}
          onOpenOnGithub={() => void openOnGithub()}
        />
      ) : (
        <CreateForm
          projectId={projectId}
          git={git}
          draft={draft}
          onCreated={() => {
            onChanged();
            onRefresh();
          }}
        />
      )}
      {error && (
        <PullRequestError title="Couldn’t open the pull request" message={error} />
      )}
    </section>
  );
}

interface CreateFormProps {
  projectId: number;
  git: GitStatus;
  /** Title, body and base prefilled from the branch's commits; null if they couldn't be read. */
  draft: PullRequestDraft | null;
  onCreated: () => void;
}

function CreateForm({ projectId, git, draft: prefill, onCreated }: CreateFormProps) {
  const id = useId();
  const submitting = useRef(false);
  const blocked = createPrBlockedReason(git);
  const [form, setForm] = useState<Pick<PullRequestDraft, "title" | "body" | "base">>({
    title: prefill?.title ?? "",
    body: prefill?.body ?? "",
    base: prefill?.base ?? "main",
  });
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (blocked) return <p className="pr-guidance">{blocked}</p>;

  const pushFirst = git.unpublished || git.ahead > 0;
  const sameBranch = form.base.trim() === git.branch;
  const canSubmit = !!form.title.trim() && !!form.base.trim() && !sameBranch;
  const feedback = error ? describeCreatePrError(error, form.base.trim()) : null;
  async function create() {
    if (submitting.current || !canSubmit) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.createPullRequest(projectId, form.title.trim(), form.body, form.base.trim(), draft);
      if (result.status === "error") setError(result.error.message);
      else onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      className="pr-form"
      aria-label="Create pull request"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <header className="pr-create-heading">
        <GitPullRequestIcon size={18} />
        <h3>Create pull request</h3>
      </header>
      <div className="pr-create-branches" aria-label="Branch comparison">
        <div className="pr-create-base">
          <label htmlFor={`${id}-base`}>Base branch</label>
          <input
            id={`${id}-base`}
            className="mono"
            value={form.base}
            required
            disabled={busy}
            aria-invalid={sameBranch || undefined}
            aria-describedby={sameBranch ? `${id}-base-error` : undefined}
            onChange={(e) => {
              setForm({ ...form, base: e.target.value });
              setError(null);
            }}
          />
        </div>
        <ArrowLeftIcon size={16} className="pr-create-arrow" aria-label="receives changes from" />
        <div className="pr-create-head">
          <span>Compare branch</span>
          <span className="pr-create-branch" title={git.branch ?? undefined}>
            <GitBranchIcon size={14} />
            <span className="mono">{git.branch}</span>
          </span>
        </div>
      </div>
      {sameBranch && <p id={`${id}-base-error`} className="pr-field-error" role="alert">Choose a base branch other than the current branch.</p>}
      <div className="pr-create-field">
        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          placeholder="A short summary of your changes"
          value={form.title}
          required
          disabled={busy}
          autoFocus
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </div>
      <div className="pr-create-field">
        <label htmlFor={`${id}-description`}>Description <span className="pr-field-optional">optional</span></label>
        <textarea
          id={`${id}-description`}
          placeholder="What changed and why?"
          rows={8}
          value={form.body}
          disabled={busy}
          aria-describedby={`${id}-description-hint`}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <span id={`${id}-description-hint`} className="pr-create-hint">Markdown supported</span>
      </div>
      {feedback && error && <PullRequestError {...feedback} message={error} />}
      <footer className="pr-create-footer">
        {pushFirst && <p className="pr-create-hint">Your branch will be pushed before the pull request is created.</p>}
        <div className="pr-create-actions">
          <label className="pr-draft">
            <input type="checkbox" checked={draft} disabled={busy} onChange={(e) => setDraft(e.target.checked)} /> Draft
          </label>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !canSubmit}
            title={`Create the pull request (${shortcutLabel}${shortcutLabel === "\u2318" ? "\u21a9" : "Enter"} in the description)`}
          >
            {busy ? <SyncIcon size={14} className="spin" /> : <GitPullRequestIcon size={14} />}
            {busy ? "Creating…" : pushFirst ? "Push & create PR" : "Create PR"}
          </button>
        </div>
      </footer>
    </form>
  );
}
