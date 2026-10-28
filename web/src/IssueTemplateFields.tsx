import { MarkdownEditor } from "./MarkdownEditor";
import { Markdown } from "./PullRequestMarkdown";
import type { FormAnswers, FormElement } from "./issueTemplates";

interface IssueTemplateFieldsProps {
  form: FormElement[];
  answers: FormAnswers;
  disabled: boolean;
  onChange: (id: string, value: string | string[] | boolean[]) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** The fields of a GitHub issue form, laid out like the web draws them. */
export function IssueTemplateFields({ form, answers, disabled, onChange, onKeyDown }: IssueTemplateFieldsProps) {
  return (
    <>
      {form.map((el, i) => {
        if (el.type === "markdown") {
          return (
            <div key={i} className="issue-form-note">
              <Markdown source={el.value} />
            </div>
          );
        }
        const id = `issue-field-${el.id}`;
        const answer = answers[el.id];
        return (
          <div key={el.id} className="pr-create-field">
            {el.type === "checkboxes" ? (
              <span className="issue-field-label" id={`${id}-label`}>
                {el.label}
              </span>
            ) : (
              <label htmlFor={id}>
                {el.label}
                {el.required && (
                  <span className="required" aria-hidden>
                    {" "}
                    *
                  </span>
                )}
              </label>
            )}
            {el.description && <p className="pr-create-hint">{el.description}</p>}
            {el.type === "input" && (
              <input
                id={id}
                placeholder={el.placeholder}
                value={typeof answer === "string" ? answer : ""}
                disabled={disabled}
                onChange={(e) => onChange(el.id, e.target.value)}
              />
            )}
            {el.type === "textarea" &&
              (el.render ? (
                <textarea
                  id={id}
                  className="mono"
                  rows={6}
                  placeholder={el.placeholder}
                  value={typeof answer === "string" ? answer : ""}
                  disabled={disabled}
                  onChange={(e) => onChange(el.id, e.target.value)}
                  onKeyDown={onKeyDown}
                />
              ) : (
                <MarkdownEditor
                  id={id}
                  label={el.label}
                  placeholder={el.placeholder}
                  rows={6}
                  value={typeof answer === "string" ? answer : ""}
                  disabled={disabled}
                  onChange={(value) => onChange(el.id, value)}
                  onKeyDown={onKeyDown}
                />
              ))}
            {el.type === "dropdown" &&
              (el.multiple ? (
                <div className="issue-options" role="group" aria-label={el.label}>
                  {el.options.map((option) => {
                    const chosen = Array.isArray(answer) ? (answer as string[]) : [];
                    return (
                      <label key={option} className="issue-option">
                        <input
                          type="checkbox"
                          checked={chosen.includes(option)}
                          disabled={disabled}
                          onChange={(e) =>
                            onChange(el.id, e.target.checked ? [...chosen, option] : chosen.filter((o) => o !== option))
                          }
                        />
                        {option}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <select
                  id={id}
                  value={typeof answer === "string" ? answer : ""}
                  disabled={disabled}
                  onChange={(e) => onChange(el.id, e.target.value)}
                >
                  {el.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ))}
            {el.type === "checkboxes" && (
              <div className="issue-options" role="group" aria-labelledby={`${id}-label`}>
                {el.options.map((option, n) => {
                  const ticked = Array.isArray(answer) ? (answer as boolean[]) : [];
                  return (
                    <label key={n} className="issue-option">
                      <input
                        type="checkbox"
                        checked={ticked[n] === true}
                        disabled={disabled}
                        onChange={(e) => onChange(el.id, el.options.map((_, k) => (k === n ? e.target.checked : ticked[k] === true)))}
                      />
                      {option.label}
                      {option.required && (
                        <span className="required" aria-hidden>
                          {" "}
                          *
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
