import { ArrowLeftIcon, IssueOpenedIcon } from "@primer/octicons-react";
import { useEffect, useState } from "react";
import { commands, type IssueSummary, type PullRequestLabel } from "./bindings";
import { IssueTemplateChooser } from "./IssueTemplateChooser";
import { IssueTemplateFields } from "./IssueTemplateFields";
import {
  formBody,
  initialAnswers,
  missingRequired,
  parseIssueTemplates,
  type FormAnswers,
  type IssueTemplate,
  type IssueTemplates,
} from "./issueTemplates";
import { canSubmitIssue } from "./issueView";
import { MarkdownEditor } from "./MarkdownEditor";
import { Working } from "./PullRequestMerge";
import { Avatar } from "./Avatar";
import { Field, LabelChip, Picker, useCandidates } from "./PullRequestPeople";
import { shortcutLabel } from "./shortcuts";

interface IssueCreateProps {
  projectId: number;
  onBack: () => void;
  onCreated: (issue: IssueSummary) => void;
}

type Templates = { state: "loading" } | { state: "ready"; templates: IssueTemplates };

/** A new issue as the web offers it: first the repository's templates to choose from (when it
 *  has any), then the form of the chosen one, or a blank one. */
export function IssueCreate({ projectId, onBack, onCreated }: IssueCreateProps) {
  const [loaded, setLoaded] = useState<Templates>({ state: "loading" });
  // `undefined` while choosing, `null` for a blank issue.
  const [chosen, setChosen] = useState<IssueTemplate | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void commands.issueTemplates(projectId).then((result) => {
      if (!active) return;
      // Templates are a convenience: if they cannot be read, a blank issue still works.
      setLoaded({ state: "ready", templates: parseIssueTemplates(result.status === "ok" ? result.data : []) });
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  if (loaded.state === "loading") {
    return (
      <div className="pr-review issue-create">
        <div className="pr-nav">
          <button type="button" className="pr-back" onClick={onBack}>
            <ArrowLeftIcon size={14} /> Issues
          </button>
        </div>
        <p className="pr-empty">Loading…</p>
      </div>
    );
  }
  const { templates } = loaded;
  const choosing = templates.templates.length > 0 || templates.config.contactLinks.length > 0;
  if (choosing && chosen === undefined) {
    return <IssueTemplateChooser templates={templates} onBack={onBack} onChoose={setChosen} />;
  }
  return (
    <IssueForm
      key={chosen?.file ?? "blank"}
      projectId={projectId}
      template={chosen ?? null}
      backLabel={choosing ? "Templates" : "Issues"}
      onBack={choosing ? () => setChosen(undefined) : onBack}
      onCreated={onCreated}
    />
  );
}

interface IssueFormProps extends IssueCreateProps {
  /** What the form starts from; `null` for a blank issue. */
  template: IssueTemplate | null;
  backLabel: string;
}

/** The new-issue form: title, description (a template's fields, or Markdown with a preview),
 *  and the assignees and labels to start it with. */
function IssueForm({ projectId, template, backLabel, onBack, onCreated }: IssueFormProps) {
  const form = template?.form ?? null;
  const [title, setTitle] = useState(template?.title ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [answers, setAnswers] = useState<FormAnswers>(() => (form ? initialAnswers(form) : {}));
  const [assignees, setAssignees] = useState<string[]>(template?.assignees ?? []);
  const [labels, setLabels] = useState<PullRequestLabel[]>(() =>
    (template?.labels ?? []).map((name) => ({ name, color: "" })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { candidates, load } = useCandidates(projectId);

  // A template can name labels the repository does not have, which GitHub's web quietly drops
  // but `gh` would refuse: keep the ones that exist, with their colours.
  useEffect(() => {
    if (template && template.labels.length > 0) load();
  }, [template, load]);
  const known = candidates.state === "ready" ? candidates.data.labels : null;
  const chosenLabels = known
    ? labels.flatMap((l) => {
        const match = known.find((k) => k.name === l.name);
        return match ? [match] : [];
      })
    : labels;

  const missing = form ? missingRequired(form, answers) : [];
  const ready = canSubmitIssue(title) && missing.length === 0 && !busy;
  const submitOnModEnter = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  };

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await commands.createIssue(
      projectId,
      title.trim(),
      form ? formBody(form, answers) : body.trim(),
      assignees,
      chosenLabels.map((l) => l.name),
    );
    setBusy(false);
    if (result.status === "ok") onCreated(result.data);
    else setError(result.error.message);
  }

  const labelOf = (name: string): PullRequestLabel => {
    return known?.find((l) => l.name === name) ?? { name, color: "" };
  };

  return (
    <form
      className="pr-review issue-create"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="pr-nav">
        <button type="button" className="pr-back" onClick={onBack} disabled={busy}>
          <ArrowLeftIcon size={14} /> {backLabel}
        </button>
      </div>
      <div className="pr-scroll">
        <div className="pr-create-heading">
          <IssueOpenedIcon size={16} className="issue-state-open" />
          <h3>{template ? `New issue: ${template.name}` : "New issue"}</h3>
        </div>
        <div className="pr-create-field">
          <label htmlFor="issue-title">
            Add a title <span className="required" aria-hidden>*</span>
          </label>
          <input
            id="issue-title"
            placeholder="Title"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {form ? (
          <IssueTemplateFields
            form={form}
            answers={answers}
            disabled={busy}
            onChange={(id, value) => setAnswers((a) => ({ ...a, [id]: value }))}
            onKeyDown={submitOnModEnter}
          />
        ) : (
          <div className="pr-create-field">
            <label htmlFor="issue-body">Description</label>
            <MarkdownEditor
              id="issue-body"
              label="Description"
              placeholder="Add a description, Markdown is supported"
              rows={8}
              value={body}
              onChange={setBody}
              onKeyDown={submitOnModEnter}
            />
          </div>
        )}
        <section className="pr-section issue-create-details" aria-label="Details">
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
                selected={chosenLabels.map((l) => l.name)}
                busy={busy}
                onToggle={async (key, on) => {
                  setLabels((list) => (on ? [...list, labelOf(key)] : list.filter((l) => l.name !== key)));
                  return true;
                }}
                onClose={close}
              />
            )}
          >
            {chosenLabels.length === 0 ? (
              <p className="pr-field-empty">None yet</p>
            ) : (
              <div className="pr-labels">
                {chosenLabels.map((l) => (
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
        <footer className="pr-create-footer" aria-label="Create">
          <div className="pr-create-actions">
            <button type="button" onClick={onBack} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className={`primary${busy ? " pending" : ""}`}
              disabled={!ready}
              title={`Create (${shortcutLabel}${shortcutLabel === "⌘" ? "↩" : "Enter"})`}
            >
              <Working on={busy} label="Creating…">
                Create issue <kbd className="kbd">{shortcutLabel}{shortcutLabel === "⌘" ? "↩" : "Enter"}</kbd>
              </Working>
            </button>
          </div>
        </footer>
      </div>
    </form>
  );
}