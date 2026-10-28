import { expect, it } from "vitest";
import { formBody, initialAnswers, missingRequired, parseIssueTemplates } from "./issueTemplates";

const bug = `name: Bug report
description: Something doesn't work.
title: "[Bug]: "
labels: [bug, needs-triage]
assignees: octocat, hubot
body:
  - type: markdown
    attributes:
      value: Thanks for reporting!
  - type: input
    id: version
    attributes:
      label: Version
      placeholder: v0.1.0
    validations:
      required: true
  - type: dropdown
    id: provider
    attributes:
      label: Provider
      options: [Claude Code, Codex]
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Logs
      render: text
  - type: checkboxes
    id: terms
    attributes:
      label: Checks
      options:
        - label: I searched first
          required: true
        - label: I can help fix it
`;

const files = [
  { name: "bug_report.yml", content: bug },
  { name: "config.yml", content: "blank_issues_enabled: false\ncontact_links:\n  - name: Security\n    url: https://example.com/s\n    about: Report privately\n  - name: Bad\n    url: http://insecure.example\n    about: x\n" },
  { name: "chore.md", content: "---\nname: Chore\nabout: Housekeeping\ntitle: 'chore: '\nlabels: maintenance\n---\n\n## What\n\n" },
  { name: "broken.yml", content: "name: [unterminated" },
  { name: "plain.md", content: "no front matter" },
];

it("reads form and Markdown templates, skipping files GitHub would ignore", () => {
  const { templates } = parseIssueTemplates(files);
  expect(templates.map((t) => t.name)).toEqual(["Bug report", "Chore"]);
  const [form, chore] = templates;
  expect(form).toMatchObject({ title: "[Bug]: ", labels: ["bug", "needs-triage"], assignees: ["octocat", "hubot"] });
  expect(form.form?.map((e) => e.type)).toEqual(["markdown", "input", "dropdown", "textarea", "checkboxes"]);
  expect(chore).toMatchObject({ description: "Housekeeping", title: "chore: ", labels: ["maintenance"], form: null });
  expect(chore.body).toBe("## What\n\n");
});

it("reads the chooser settings, keeping only https contact links", () => {
  const { config } = parseIssueTemplates(files);
  expect(config.blankIssuesEnabled).toBe(false);
  expect(config.contactLinks).toEqual([{ name: "Security", url: "https://example.com/s", about: "Report privately" }]);
  expect(parseIssueTemplates([]).config).toEqual({ blankIssuesEnabled: true, contactLinks: [] });
});

it("composes the description the way the web does", () => {
  const form = parseIssueTemplates(files).templates[0].form!;
  const answers = { ...initialAnswers(form), version: "v1.2.0", logs: "boom", terms: [true, false] };
  expect(formBody(form, answers)).toBe(
    [
      "### Version\n\nv1.2.0",
      "### Provider\n\nClaude Code",
      "### Logs\n\n```text\nboom\n```",
      "### Checks\n\n- [x] I searched first\n- [ ] I can help fix it",
    ].join("\n\n"),
  );
  expect(formBody(form, { ...answers, logs: "" })).toContain("### Logs\n\n_No response_");
});

it("reports required fields and boxes that are still missing", () => {
  const form = parseIssueTemplates(files).templates[0].form!;
  expect(missingRequired(form, initialAnswers(form))).toEqual(["Version", "Checks"]);
  expect(missingRequired(form, { ...initialAnswers(form), version: " v1 ", terms: [true, false] })).toEqual([]);
});
