import { ArrowLeftIcon } from "@primer/octicons-react";
import { useState } from "react";
import { commands, type IssueSummary, type PullRequestLabel } from "./bindings";
import { canSubmitIssue } from "./issueView";
import { Markdown } from "./PullRequestMarkdown";
import { Working } from "./PullRequestMerge";
import { Avatar } from "./Avatar";
import { Field, LabelChip, Picker, useCandidates } from "./PullRequestPeople";
import { shortcutLabel } from "./shortcuts";

interface IssueCreateProps {
  projectId: number;
  onBack: () => void;
  onCreated: (issue: IssueSummary) => void;
}

/** A new issue as the web form offers it: title, a description written in Markdown with a
 *  preview, and the assignees and labels to start it with. */
export function IssueCreate({ projectId, onBack, onCreated }: IssueCreateProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labels, setLabels] = useState<PullRequestLabel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { candidates, load } = useCandidates(projectId);

  const ready = canSubmitIssue(title) && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await commands.createIssue(
      projectId,
      title.trim(),
      body.trim(),
      assignees,
      labels.map((l) => l.name),
    );
    setBusy(false);
    if (result.status === "ok") onCreated(result.data);
    else setError(result.error.message);
  }

  const labelOf = (name: string): PullRequestLabel => {
    const known = candidates.state === "ready" ? candidates.data.labels.find((l) => l.name === name) : undefined;
    return known ?? { name, color: "" };
  };

  return (
    <form
      className="pr-review"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="pr-nav">
        <button type="button" className="pr-back" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon size={14} /> Issues
        </button>
      </div>
      <div className="pr-scroll">
        <h3 className="pr-title">New issue</h3>
        <div className="pr-create-field">
          <label htmlFor="issue-title">Title</label>
          <input
            id="issue-title"
            placeholder="Title"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="pr-create-field">
          <div className="issue-write-head">
            <label htmlFor="issue-body">
              Description <span className="pr-field-optional">optional</span>
            </label>
            <div className="pr-seg" role="group" aria-label="Description mode">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                Write
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                Preview
              </button>
            </div>
          </div>
          {preview ? (
            <div className="issue-preview">
              {body.trim() ? <Markdown source={body} /> : <p className="pr-field-empty">Nothing to preview.</p>}
            </div>
          ) : (
            <textarea
              id="issue-body"
              placeholder="Add a description, Markdown is supported"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
          )}
        </div>
        <section className="pr-section pr-details" aria-label="Details">
          <Field
            title="Assignees"
            editable
            picker={(close) => (
              <Picker
                title="Assign up to 10 people"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.users.map((u) => ({ key: u, label: u, login: u }))}
                selected={assignees}
                busy={busy}
                onToggle={async (key, on) => {
                  setAssignees((list) => (on ? [...list, key] : list.filter((a) => a !== key)));
                  return true;
                }}
                onClose={close}
              />
            )}
          >
            {assignees.length === 0 ? (
              <p className="pr-field-empty">No one</p>
            ) : (
              <ul className="pr-people">
                {assignees.map((login) => (
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
            picker={(close) => (
              <Picker
                title="Apply labels"
                candidates={candidates}
                onOpen={load}
                items={(c) => c.labels.map((l) => ({ key: l.name, label: l.name, color: l.color }))}
                selected={labels.map((l) => l.name)}
                busy={busy}
                onToggle={async (key, on) => {
                  setLabels((list) => (on ? [...list, labelOf(key)] : list.filter((l) => l.name !== key)));
                  return true;
                }}
                onClose={close}
              />
            )}
          >
            {labels.length === 0 ? (
              <p className="pr-field-empty">None yet</p>
            ) : (
              <div className="pr-labels">
                {labels.map((l) => (
                  <LabelChip key={l.name} label={l} />
                ))}
              </div>
            )}
          </Field>
        </section>
        {error && (
          <p role="alert" className="pr-error">
            {error}
          </p>
        )}
      </div>
      <footer className="pr-merge" aria-label="Create">
        <div className="pr-merge-row">
          <button
            type="submit"
            className={`primary${busy ? " pending" : ""}`}
            disabled={!ready}
            title={`Create (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
          >
            <Working on={busy} label="Creating…">
              Create issue
            </Working>
          </button>
          <button type="button" onClick={onBack} disabled={busy}>
            Cancel
          </button>
        </div>
      </footer>
    </form>
  );
}
