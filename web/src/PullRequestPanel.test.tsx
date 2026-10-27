// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { PullRequestPanel } from "./PullRequestPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const onChanged = vi.fn();
const branch = "fix/pr-polish";
const diagnostic = `pull request create failed: GraphQL: No commits between main and ${branch} (createPullRequest)`;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "pullRequestState").mockResolvedValue({
    status: "ok", data: { availability: "ready", branch, pullRequest: null, guidance: null, defaultBranch: "main" },
  });
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok", data: { branch, upstream: null, ahead: 1, behind: 0, added: 1, removed: 0,
      changedFiles: 1, protected: false, unpublished: true, pickerDisabledReason: null },
  });
  vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({
    status: "ok", data: { title: "Polish PR creation", body: "Changes and validation.", base: "main", head: branch },
  });
  vi.spyOn(commands, "pullRequestBaseBranches").mockResolvedValue({ status: "ok", data: ["develop", "main", "release/next", branch] });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  onChanged.mockReset();
});
async function render() {
  await act(async () => root.render(<PullRequestPanel projectId={1} refreshKey={0}
    onChanged={onChanged} onReviewFiles={() => {}} />));
}
async function submit() {
  await act(async () => host.querySelector("form")!.requestSubmit());
}
function input(name: string) {
  return host.querySelector<HTMLInputElement>(`[id$="-${name}"]`)!;
}
async function edit(name: string, value: string) {
  await act(async () => {
    const el = input(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function baseSelect() {
  return host.querySelector<HTMLButtonElement>(".pr-base-select")!;
}
async function chooseBase(name: string) {
  await act(async () => baseSelect().click());
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((option) => option.textContent === name)!;
  await act(async () => option.click());
}

it("offers GitHub branches, selects the default and excludes the PR's own branch", async () => {
  const create = vi.spyOn(commands, "createPullRequest").mockResolvedValue({ status: "error", error: { message: diagnostic } });
  await render();
  expect(baseSelect().getAttribute("aria-label")).toBe("Base branch: main");
  expect(host.querySelector('input[aria-label="Base branch"]')).toBeNull();
  await act(async () => baseSelect().click());
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent))
    .toEqual(["develop", "main", "release/next"]);
  await act(async () => document.querySelector<HTMLElement>('[role="option"]')!.click());
  await submit();
  expect(create).toHaveBeenCalledWith(1, "Polish PR creation", "Changes and validation.", "develop", false);
});

it("preserves the draft on failure and offers readable recovery with the original diagnostic", async () => {
  vi.spyOn(commands, "createPullRequest").mockResolvedValue({ status: "error", error: { message: diagnostic } });
  await render();
  await submit();
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("No commits to compare");
  expect(alert.textContent).toContain("Commit your changes or choose a different base branch");
  expect(alert.querySelector("details")!.open).toBe(false);
  expect(alert.querySelector("pre")!.textContent).toBe(diagnostic);
  expect(input("title").value).toBe("Polish PR creation");
  expect(host.querySelector("textarea")!.value).toBe("Changes and validation.");
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
  await chooseBase("develop");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("blocks empty titles, including programmatic submission", async () => {
  const create = vi.spyOn(commands, "createPullRequest");
  await render();
  await edit("title", "   ");
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it("prevents duplicate keyboard submissions while pending and restores controls after a rejected request", async () => {
  let reject!: (error: Error) => void;
  const create = vi.spyOn(commands, "createPullRequest").mockImplementation(() =>
    new Promise((_, fail) => { reject = fail; }));
  await render();
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
    host.querySelector("form")!.requestSubmit();
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(host.querySelector("form")!.getAttribute("aria-busy")).toBe("true");
  expect(baseSelect().disabled).toBe(true);
  expect(host.querySelector("textarea")!.disabled).toBe(true);
  await act(async () => reject(new Error("Failed to connect to github.com")));
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Couldn’t reach GitHub");
  expect(baseSelect().disabled).toBe(false);
});

it("blocks creation while branch choices load", async () => {
  let resolve!: (result: { status: "ok"; data: string[] }) => void;
  vi.mocked(commands.pullRequestBaseBranches).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const create = vi.spyOn(commands, "createPullRequest");
  await render();
  expect(baseSelect().disabled).toBe(true);
  await submit();
  expect(create).not.toHaveBeenCalled();
  await act(async () => resolve({ status: "ok", data: ["main"] }));
  expect(baseSelect().disabled).toBe(false);
});

it("preserves the form and offers retry when GitHub branches cannot be loaded", async () => {
  vi.mocked(commands.pullRequestBaseBranches).mockResolvedValueOnce({ status: "error", error: { message: "HTTP 403" } });
  await render();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Couldn’t load base branches");
  expect(baseSelect().disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  await edit("title", "Keep this title");
  await act(async () => Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "Try again")!.click());
  expect(baseSelect().getAttribute("aria-label")).toBe("Base branch: main");
  expect(input("title").value).toBe("Keep this title");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("uses another available branch when the preferred base is missing", async () => {
  vi.mocked(commands.pullRequestBaseBranches).mockResolvedValue({ status: "ok", data: ["release/next", branch] });
  await render();
  expect(baseSelect().getAttribute("aria-label")).toBe("Base branch: release/next");
});

it("blocks creation if no other branch exists on GitHub", async () => {
  vi.mocked(commands.pullRequestBaseBranches).mockResolvedValue({ status: "ok", data: [branch] });
  const create = vi.spyOn(commands, "createPullRequest");
  await render();
  expect(host.querySelector('[role="status"]')!.textContent).toContain("No other branches");
  expect(baseSelect().disabled).toBe(true);
  await submit();
  expect(create).not.toHaveBeenCalled();
});

it.each(["ctrlKey", "metaKey"])("submits with %s+Enter and preserves draft choice", async (modifier) => {
  const create = vi.spyOn(commands, "createPullRequest").mockResolvedValue({ status: "error", error: { message: diagnostic } });
  await render();
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  await act(async () => host.querySelector("textarea")!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true })));
  expect(create).toHaveBeenCalledExactlyOnceWith(1, "Polish PR creation", "Changes and validation.", "main", true);
});

it("notifies the parent and reloads the PR after successful creation", async () => {
  vi.spyOn(commands, "createPullRequest").mockResolvedValue({
    status: "ok", data: { number: 10, title: "Polish PR creation", url: "https://github.com/example/repo/pull/10",
      head: branch, base: "main", draft: false, author: "demo", createdAt: "2026-10-27T09:00:00Z" },
  });
  await render();
  await submit();
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(commands.pullRequestState).toHaveBeenCalledTimes(2);
});
