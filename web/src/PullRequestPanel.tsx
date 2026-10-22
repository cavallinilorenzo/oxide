import { useCallback, useEffect, useState } from "react";
import { commands, type GitStatus, type PullRequestDraft, type PullRequestState } from "./bindings";
import { createPrBlockedReason } from "./gitAction";

interface PullRequestPanelProps {
  projectId: number;
  /** Changes after the user's own Git changes (commit, push, pull, checkout), which refresh the panel. */
  refreshKey: number;
  /** Called after a pull request was created, so other Git views reload. */
  onChanged: () => void;
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; pr: PullRequestState; git: GitStatus };

/** The branch's pull request on GitHub, through `gh`. It loads when opened and
 *  after the user's own Git changes or a manual refresh; it never polls.
 *  State belongs to one Project, so a different one remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestBody key={props.projectId} {...props} />;
}

function PullRequestBody({ projectId, refreshKey, onChanged }: PullRequestPanelProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [error, setError] = useState<string | null>(null);

  // Bumped by the Refresh button: the only reload besides opening and the user's own changes.
  const [manual, setManual] = useState(0);
  const load = useCallback(() => setManual((n) => n + 1), []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [pr, git] = await Promise.all([commands.pullRequestState(projectId), commands.gitStatus(projectId)]);
      if (!active) return;
      if (pr.status === "error") setLoaded({ state: "error", message: pr.error.message });
      else if (git.status === "error") setLoaded({ state: "error", message: git.error.message });
      else setLoaded({ state: "ready", pr: pr.data, git: git.data });
    })();
    return () => {
      active = false;
    };
  }, [projectId, refreshKey, manual]);

  const refresh = (
    <button className="pr-refresh" onClick={load} title="Reload from GitHub">
      Refresh
    </button>
  );

  async function openOnGithub() {
    setError(null);
    const result = await commands.openPullRequest(projectId);
    if (result.status === "error") setError(result.error.message);
  }

  if (loaded.state === "loading") return <section className="pr-panel" aria-label="Pull request" />;
  if (loaded.state === "error") {
    return (
      <section className="pr-panel" aria-label="Pull request">
        <p role="alert">{loaded.message}</p>
        {refresh}
      </section>
    );
  }

  const { pr, git } = loaded;
  if (pr.availability !== "ready") {
    return (
      <section className="pr-panel" aria-label="Pull request">
        <p className="pr-guidance">{pr.guidance}</p>
        {refresh}
      </section>
    );
  }

  const existing = pr.pullRequest;
  return (
    <section className="pr-panel" aria-label="Pull request">
      {existing ? (
        <>
          <h3>
            #{existing.number} {existing.title}
            {existing.draft && <span className="badge">draft</span>}
          </h3>
          <p>
            {existing.head} → {existing.base}
          </p>
          <div className="pr-actions">
            <button onClick={() => void openOnGithub()}>Open on GitHub</button>
            {refresh}
          </div>
        </>
      ) : (
        <>
          <CreateForm
            projectId={projectId}
            git={git}
            onCreated={() => {
              onChanged();
              load();
            }}
          />
          <div className="pr-actions">{refresh}</div>
        </>
      )}
      {error && (
        <p role="alert" className="git-error-text">
          {error}
        </p>
      )}
    </section>
  );
}

interface CreateFormProps {
  projectId: number;
  git: GitStatus;
  onCreated: () => void;
}

function CreateForm({ projectId, git, onCreated }: CreateFormProps) {
  const blocked = createPrBlockedReason(git);
  const [form, setForm] = useState<Pick<PullRequestDraft, "title" | "body" | "base"> | null>(null);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (blocked) return;
    let active = true;
    void commands.pullRequestDraft(projectId).then((result) => {
      if (!active) return;
      if (result.status === "ok") setForm({ title: result.data.title, body: result.data.body, base: result.data.base });
      else setError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId, blocked]);

  if (blocked) return <p className="pr-guidance">{blocked}</p>;
  if (!form) return error ? <p role="alert">{error}</p> : null;

  async function create(current: NonNullable<typeof form>) {
    setBusy(true);
    setError(null);
    const result = await commands.createPullRequest(
      projectId,
      current.title,
      current.body,
      current.base,
      draft,
    );
    setBusy(false);
    if (result.status === "error") setError(result.error.message);
    else onCreated();
  }

  return (
    <form
      className="pr-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create(form);
      }}
    >
      <p>
        {git.branch} has no pull request.
        {(git.unpublished || git.ahead > 0) && " It is pushed first."}
      </p>
      <input
        aria-label="Title"
        placeholder="Title"
        value={form.title}
        onChange={(e) => setForm({ ...form, title: e.target.value })}
      />
      <textarea
        aria-label="Description"
        placeholder="Description"
        rows={6}
        value={form.body}
        onChange={(e) => setForm({ ...form, body: e.target.value })}
      />
      <label>
        Base{" "}
        <input aria-label="Base branch" value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} />
      </label>
      <label>
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
      </label>
      <button type="submit" disabled={busy || !form.title.trim() || !form.base.trim()}>
        {busy ? "Creating…" : "Create pull request"}
      </button>
      {error && (
        <p role="alert" className="git-error-text">
          {error}
        </p>
      )}
    </form>
  );
}
