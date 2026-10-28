import { parse } from "yaml";
import type { IssueTemplateFile } from "./bindings";

/** One field of a GitHub issue form. `markdown` is display-only text; the rest collect input. */
export type FormElement =
  | { type: "markdown"; value: string }
  | { type: "input"; id: string; label: string; description: string; placeholder: string; value: string; required: boolean }
  | {
      type: "textarea";
      id: string;
      label: string;
      description: string;
      placeholder: string;
      value: string;
      /** A language to fence the answer in, so it shows as code. */
      render: string;
      required: boolean;
    }
  | {
      type: "dropdown";
      id: string;
      label: string;
      description: string;
      options: string[];
      multiple: boolean;
      required: boolean;
    }
  | {
      type: "checkboxes";
      id: string;
      label: string;
      description: string;
      options: { label: string; required: boolean }[];
    };

export interface IssueTemplate {
  /** The file it came from: a stable key. */
  file: string;
  name: string;
  description: string;
  /** What the title starts with. */
  title: string;
  labels: string[];
  assignees: string[];
  /** A YAML issue form, or a Markdown template whose text prefills the description. */
  form: FormElement[] | null;
  /** The prefilled description of a Markdown template. */
  body: string;
}

export interface IssueTemplateConfig {
  /** Whether the web offers "Blank issue". */
  blankIssuesEnabled: boolean;
  contactLinks: { name: string; url: string; about: string }[];
}

export interface IssueTemplates {
  templates: IssueTemplate[];
  config: IssueTemplateConfig;
}

const NO_RESPONSE = "_No response_";

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** `labels: bug` and `labels: [bug, docs]` and `labels: "bug, docs"` all mean the same. */
function names(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(str) : str(v).split(",");
  return list.map((s) => s.trim()).filter((s) => s !== "");
}

function safeYaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

function formElement(raw: unknown, index: number): FormElement | null {
  if (!isRecord(raw)) return null;
  const attrs = isRecord(raw.attributes) ? raw.attributes : {};
  const required = isRecord(raw.validations) && raw.validations.required === true;
  const id = str(raw.id) || `field-${index}`;
  const label = str(attrs.label);
  const description = str(attrs.description);
  switch (raw.type) {
    case "markdown":
      return { type: "markdown", value: str(attrs.value) };
    case "input":
      return { type: "input", id, label, description, placeholder: str(attrs.placeholder), value: str(attrs.value), required };
    case "textarea":
      return {
        type: "textarea",
        id,
        label,
        description,
        placeholder: str(attrs.placeholder),
        value: str(attrs.value),
        render: str(attrs.render),
        required,
      };
    case "dropdown":
      return {
        type: "dropdown",
        id,
        label,
        description,
        options: Array.isArray(attrs.options) ? attrs.options.map(str) : [],
        multiple: attrs.multiple === true,
        required,
      };
    case "checkboxes":
      return {
        type: "checkboxes",
        id,
        label,
        description,
        options: (Array.isArray(attrs.options) ? attrs.options : [])
          .filter(isRecord)
          .map((o) => ({ label: str(o.label), required: o.required === true })),
      };
    default:
      return null;
  }
}

function formTemplate(file: string, doc: Raw): IssueTemplate {
  const body = Array.isArray(doc.body) ? doc.body : [];
  return {
    file,
    name: str(doc.name) || file,
    description: str(doc.description),
    title: str(doc.title),
    labels: names(doc.labels),
    assignees: names(doc.assignees),
    form: body.map(formElement).filter((e): e is FormElement => e !== null),
    body: "",
  };
}

/** A Markdown template: front matter (`name`, `about`, `title`, `labels`, `assignees`) over the prefilled text. */
function markdownTemplate(file: string, content: string): IssueTemplate | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return null;
  const front = safeYaml(match[1]);
  if (!isRecord(front)) return null;
  return {
    file,
    name: str(front.name) || file,
    description: str(front.about),
    title: str(front.title),
    labels: names(front.labels),
    assignees: names(front.assignees),
    form: null,
    body: match[2].replace(/^\s*\r?\n/, ""),
  };
}

function config(content: string | undefined): IssueTemplateConfig {
  const doc = content === undefined ? null : safeYaml(content);
  const raw = isRecord(doc) ? doc : {};
  const links = Array.isArray(raw.contact_links) ? raw.contact_links : [];
  return {
    // The web shows "Blank issue" unless the repository turns it off.
    blankIssuesEnabled: raw.blank_issues_enabled !== false,
    contactLinks: links
      .filter(isRecord)
      .map((l) => ({ name: str(l.name), url: str(l.url), about: str(l.about) }))
      .filter((l) => l.name !== "" && l.url.startsWith("https://")),
  };
}

const isConfig = (name: string) => /^config\.ya?ml$/i.test(name);

/** The templates and chooser settings in the repository's `.github/ISSUE_TEMPLATE` files. */
export function parseIssueTemplates(files: IssueTemplateFile[]): IssueTemplates {
  const templates: IssueTemplate[] = [];
  for (const { name, content } of files) {
    if (isConfig(name)) continue;
    if (/\.ya?ml$/i.test(name)) {
      const doc = safeYaml(content);
      // GitHub ignores a form without a name, description or body.
      if (isRecord(doc) && str(doc.name) && Array.isArray(doc.body)) templates.push(formTemplate(name, doc));
    } else {
      const template = markdownTemplate(name, content);
      if (template) templates.push(template);
    }
  }
  const raw = files.find((f) => isConfig(f.name))?.content;
  return { templates, config: config(raw) };
}

/** What the user has typed per form field: text, a choice, or the ticked options. */
export type FormAnswers = Record<string, string | string[] | boolean[]>;

/** The answers a form starts with: the template's own defaults. */
export function initialAnswers(form: FormElement[]): FormAnswers {
  const answers: FormAnswers = {};
  for (const el of form) {
    if (el.type === "input" || el.type === "textarea") answers[el.id] = el.value;
    else if (el.type === "dropdown") answers[el.id] = el.multiple ? [] : (el.options[0] ?? "");
    else if (el.type === "checkboxes") answers[el.id] = el.options.map(() => false);
  }
  return answers;
}

function answered(el: FormElement, answers: FormAnswers): boolean {
  const a = answers[el.type === "markdown" ? "" : el.id];
  if (el.type === "input" || el.type === "textarea") return typeof a === "string" && a.trim() !== "";
  if (el.type === "dropdown") return Array.isArray(a) ? a.length > 0 : typeof a === "string" && a !== "";
  if (el.type === "checkboxes") {
    const ticked = Array.isArray(a) ? (a as boolean[]) : [];
    return el.options.every((o, i) => !o.required || ticked[i] === true);
  }
  return true;
}

/** The labels of required fields still empty (or required boxes still unticked). */
export function missingRequired(form: FormElement[], answers: FormAnswers): string[] {
  return form
    .filter((el) => {
      if (el.type === "markdown") return false;
      const needed = el.type === "checkboxes" ? el.options.some((o) => o.required) : el.required;
      return needed && !answered(el, answers);
    })
    .map((el) => (el.type === "markdown" ? "" : el.label));
}

/** The description GitHub composes from a form: each answer under a `### Label` heading. */
export function formBody(form: FormElement[], answers: FormAnswers): string {
  const sections: string[] = [];
  for (const el of form) {
    if (el.type === "markdown") continue;
    const a = answers[el.id];
    let value: string;
    if (el.type === "checkboxes") {
      const ticked = Array.isArray(a) ? (a as boolean[]) : [];
      value = el.options.map((o, i) => `- [${ticked[i] ? "x" : " "}] ${o.label}`).join("\n");
    } else if (el.type === "dropdown") {
      value = (Array.isArray(a) ? a.join(", ") : str(a)).trim() || NO_RESPONSE;
    } else {
      const text = str(a).trim();
      value = text === "" ? NO_RESPONSE : el.type === "textarea" && el.render ? `\`\`\`${el.render}\n${text}\n\`\`\`` : text;
    }
    sections.push(`### ${el.label}\n\n${value}`);
  }
  return sections.join("\n\n");
}
