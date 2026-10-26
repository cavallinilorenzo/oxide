import { shortcutLabel } from "./shortcuts";
import { useCallback, useEffect, useState } from "react";
import { GitPullRequestIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type GitStatus, type PullRequestDraft, type PullRequestState } from "./bindings";
import { createPrBlockedReason } from "./gitAction";
import { PullRequestBrowser, PullRequestReview } from "./PullRequestBrowser";

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
        <p role="alert" className="error">{loaded.message}</p>
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
        <p role="alert" className="error">
          {error}
        </p>
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
  async function create() {
    setBusy(true);
    setError(null);
    const result = await commands.createPullRequest(projectId, form.title, form.body, form.base, draft);
    setBusy(false);
    if (result.status === "error") setError(result.error.message);
    else onCreated();
  }

  return (
    <form
      className="pr-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <p className="dim">
        No pull request for <span className="mono">{git.branch}</span> yet.
      </p>
      <input
        aria-label="Title"
        placeholder="Title"
        value={form.title}
        autoFocus
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <textarea
        aria-label="Description"
        placeholder="Description"
        rows={8}
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="pr-form-row">
        <label className="pr-base">
          base
          <input
            aria-label="Base branch"
            className="mono"
            value={form.base}
            onChange={(e) => setForm({ ...form, base: e.target.value })}
          />
        </label>
        <label className="pr-draft">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
        </label>
        <span className="grow" />
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !form.title.trim() || !form.base.trim()}
          title={`Create the pull request (${shortcutLabel}${shortcutLabel === "\u2318" ? "\u21a9" : "Enter"} in the description)`}
        >
          <GitPullRequestIcon size={14} />
          {busy ? "Creating…" : pushFirst ? "Push & create PR" : "Create PR"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
