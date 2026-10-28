// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type IssueSummary } from "./bindings";
import { IssueCreate } from "./IssueCreate";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

const bug = `name: Bug report
description: Something doesn't work.
labels: [bug, no-such-label]
body:
  - type: input
    id: version
    attributes:
      label: Version
    validations:
      required: true
  - type: dropdown
    id: provider
    attributes:
      label: Provider
      options: [Claude Code, Codex]
`;
const config = "blank_issues_enabled: false\ncontact_links:\n  - name: Security\n    url: https://example.com/s\n    about: Report privately\n";

const created = { number: 9, title: "Crash" } as IssueSummary;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({
    status: "ok",
    data: { users: ["me"], labels: [{ name: "bug", color: "d73a4a" }] },
  } as never);
  vi.spyOn(commands, "createIssue").mockResolvedValue({ status: "ok", data: created });
  vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function render(files: { name: string; content: string }[]) {
  vi.spyOn(commands, "issueTemplates").mockResolvedValue({ status: "ok", data: files });
  const onCreated = vi.fn();
  await act(async () => root.render(<IssueCreate projectId={1} onBack={() => {}} onCreated={onCreated} />));
  // Let the templates arrive.
  await act(async () => {});
  return onCreated;
}
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(name)) as HTMLButtonElement;
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

it("offers the repository's templates, a blank issue and its contact links", async () => {
  await render([
    { name: "bug_report.yml", content: bug },
    { name: "config.yml", content: config },
  ]);
  expect(host.textContent).toContain("Create new issue");
  expect(host.textContent).toContain("Bug report");
  expect(host.textContent).toContain("Something doesn't work.");
  expect(host.textContent).toContain("Maintainers only");
  await act(async () => button("Security").click());
  expect(commands.openLink).toHaveBeenCalledWith("https://example.com/s");
});

it("creates an issue from a template with its fields, answers and the labels that exist", async () => {
  const onCreated = await render([{ name: "bug_report.yml", content: bug }]);
  await act(async () => button("Bug report").click());
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  // A required field is empty
  expect(submit().disabled).toBe(true);

  await type(host.querySelector<HTMLInputElement>("#issue-title")!, "Crash");
  await type(host.querySelector<HTMLInputElement>("#issue-field-version")!, "v1.0");
  expect(submit().disabled).toBe(false);
  await act(async () => submit().click());

  expect(commands.createIssue).toHaveBeenCalledWith(
    1,
    "Crash",
    "### Version\n\nv1.0\n\n### Provider\n\nClaude Code",
    [],
    ["bug"],
  );
  expect(onCreated).toHaveBeenCalledWith(created);
});

it("goes straight to a blank form when the repository has no templates", async () => {
  await render([]);
  expect(host.querySelector("#issue-body")).not.toBeNull();
  expect(host.textContent).not.toContain("Create new issue");
});
