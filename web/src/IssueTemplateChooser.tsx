import { ArrowLeftIcon, ArrowRightIcon, LinkExternalIcon } from "@primer/octicons-react";
import { commands } from "./bindings";
import type { IssueTemplate, IssueTemplates } from "./issueTemplates";

interface IssueTemplateChooserProps {
  templates: IssueTemplates;
  onBack: () => void;
  onChoose: (template: IssueTemplate | null) => void;
}

/** "Create new issue": the repository's templates, then a blank issue, then its contact links,
 *  in the order the web lists them. */
export function IssueTemplateChooser({ templates, onBack, onChoose }: IssueTemplateChooserProps) {
  const { config } = templates;
  return (
    <div className="pr-review issue-create">
      <div className="pr-nav">
        <button type="button" className="pr-back" onClick={onBack}>
          <ArrowLeftIcon size={14} /> Issues
        </button>
      </div>
      <div className="pr-scroll">
        <div className="pr-create-heading">
          <h3>Create new issue</h3>
        </div>
        <ul className="issue-templates" aria-label="Issue templates">
          {templates.templates.map((template) => (
            <li key={template.file}>
              <button type="button" className="issue-template" onClick={() => onChoose(template)}>
                <span className="issue-template-body">
                  <span className="issue-template-name">{template.name}</span>
                  {template.description && <span className="issue-template-about">{template.description}</span>}
                </span>
                <ArrowRightIcon size={16} />
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="issue-template" onClick={() => onChoose(null)}>
              <span className="issue-template-body">
                <span className="issue-template-name">
                  Blank issue
                  {!config.blankIssuesEnabled && <span className="issue-template-badge">Maintainers only</span>}
                </span>
                <span className="issue-template-about">Create a new issue from scratch</span>
              </span>
              <ArrowRightIcon size={16} />
            </button>
          </li>
          {config.contactLinks.map((link) => (
            <li key={link.url}>
              <button type="button" className="issue-template" onClick={() => void commands.openLink(link.url)}>
                <span className="issue-template-body">
                  <span className="issue-template-name">{link.name}</span>
                  {link.about && <span className="issue-template-about">{link.about}</span>}
                </span>
                <LinkExternalIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
