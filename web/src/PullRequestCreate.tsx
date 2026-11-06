import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SyncIcon,
} from "@primer/octicons-react";
import { commands, type DossierSection, type PullRequest } from "./bindings";
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
  const [dossierRetry, setDossierRetry] = useState(0);
  const [publishDossier, setPublishDossier] = useState(true);
  const [includePrompts, setIncludePrompts] = useState(false);
  const [includeMessage, setIncludeMessage] = useState(false);
  const [fetched, setFetched] = useState<{
    key: string;
    section: DossierSection | null;
    error: string | null;
  } | null>(null);
  const [dossierText, setDossierText] = useState("");
  const ready = !loading && !blocked && base !== "";
  const offersDossier = threadId !== null;
  // A preview answers one set of options; another set means a new one is on its way.
  const dossierKey = `${projectId}:${threadId}:${includePrompts}:${includeMessage}:${dossierRetry}`;
  const current = fetched?.key === dossierKey ? fetched : null;
  const section = current?.section ?? null;
  const dossierError = current?.error ?? null;
  useEffect(() => {
    if (!offersDossier || !ready || !publishDossier) return;
    let active = true;
    void commands
      .dossierPullRequestSection(
        projectId,
        threadId,
        includePrompts,
        includeMessage,
      )
      .then((result) => {
        if (!active) return;
        if (result.status === "error")
          setFetched({
            key: dossierKey,
            section: null,
            error: result.error.message,
          });
        else {
          setFetched({ key: dossierKey, section: result.data, error: null });
          setDossierText(result.data.markdown);
        }
      })
      .catch((cause) => {
        if (active)
          setFetched({
            key: dossierKey,
            section: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      active = false;
    };
  }, [
    projectId,
    threadId,
    offersDossier,
    ready,
    publishDossier,
    includePrompts,
    includeMessage,
    dossierKey,
  ]);
  // Publishing needs a previewed section; without one the body goes out as written.
  const publishing = offersDossier && publishDossier;
  const previewPending = publishing && section === null && !dossierError;
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
    if (
      busy ||
      loading ||
      blocked ||
      !title.trim() ||
      !base ||
      base === head ||
      previewPending
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await commands.createPullRequest(projectId, threadId, {
        title: title.trim(),
        body,
        base,
        draft,
        dossierSection:
          publishing && section && dossierText.trim() ? dossierText : null,
        dossierIncludePrompts: includePrompts,
        dossierIncludeAgentMessage: includeMessage,
      });
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
          {offersDossier && (
            <fieldset className="pr-create-dossier" disabled={busy}>
              <legend>Verification Dossier</legend>
              <label>
                <input
                  type="checkbox"
                  checked={publishDossier}
                  onChange={(e) => setPublishDossier(e.target.checked)}
                />{" "}
                Add the Dossier to the description
              </label>
              {publishDossier && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={includePrompts}
                      onChange={(e) => setIncludePrompts(e.target.checked)}
                    />{" "}
                    Include my prompts
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={includeMessage}
                      onChange={(e) => setIncludeMessage(e.target.checked)}
                    />{" "}
                    Include the agent’s closing message
                  </label>
                  {section && (
                    <>
                      <p role="status" className="pr-create-visibility">
                        {visibilityNotice(section.visibility)}
                      </p>
                      <MarkdownEditor
                        label="Dossier preview"
                        value={dossierText}
                        onChange={setDossierText}
                        disabled={busy}
                        rows={10}
                      />
                      <p className="dim">
                        Editing or toggling an option above rewrites this
                        preview. Clear it to publish nothing.
                      </p>
                    </>
                  )}
                  {previewPending && (
                    <p role="status">Preparing the Dossier…</p>
                  )}
                  {dossierError && (
                    <p role="alert">
                      The Dossier could not be prepared: {dossierError}{" "}
                      <button
                        type="button"
                        onClick={() => setDossierRetry((n) => n + 1)}
                      >
                        Try again
                      </button>
                    </p>
                  )}
                </>
              )}
            </fieldset>
          )}
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
            disabled={
              busy || !title.trim() || !base || base === head || previewPending
            }
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

function visibilityNotice(visibility: DossierSection["visibility"]): string {
  switch (visibility) {
    case "public":
      return "This repository is public: anyone can read the Dossier once the pull request is open.";
    case "private":
      return "This repository is private: only people with access to it can read the Dossier.";
    case "internal":
      return "This repository is internal: everyone in your organization can read the Dossier.";
    default:
      return "Oxide could not tell who can read this repository. Treat the Dossier as public.";
  }
}
