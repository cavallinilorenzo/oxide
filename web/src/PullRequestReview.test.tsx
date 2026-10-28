// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type PullRequestDetail } from "./bindings";
import { PullRequestReview } from "./PullRequestBrowser";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
const onChanged = vi.fn();
const onBack = vi.fn();

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    pullRequest: {
      number: 174,
      title: "chore(deps): bump react-virtual",
      url: "https://github.com/me/oxide/pull/174",
      draft: false,
      base: "main",
      head: "dependabot/npm/react-virtual",
      author: "app/dependabot",
      createdAt: "2026-10-27T08:00:00Z",
    },
    phase: "open",
    body: "Bumps react-virtual.\n\nUpdates from 3.14.21 to 3.14.22",
    checks: [
      { name: "web", state: "failure", url: "https://github.com/me/oxide/actions/runs/1" },
      { name: "rust", state: "success", url: null },
    ],
    comments: [
      { author: "bob", body: "Rename this", createdAt: "2026-10-27T10:00:00Z", review: "changesRequested" },
      { author: "app/dependabot", body: "Rebased", createdAt: "2026-10-27T11:00:00Z", review: null },
    ],
    mergeState: "clean",
    reviewDecision: null,
    reviewers: [{ login: "bob", state: "changesRequested" }],
    assignees: [],
    labels: [{ name: "dependencies", color: "0366d6" }],
    additions: 10,
    deletions: 4,
    viewer: "me",
    mergeMethods: ["merge", "squash", "rebase"],
    defaultMergeMethod: "squash",
    deleteBranchOnMerge: false,
    diff: { base: "main", files: [] },
    ...overrides,
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok",
    data: { branch: "main", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0,
      protected: true, unpublished: false, pickerDisabledReason: null },
  });
  vi.spyOn(commands, "pullRequestDetail").mockResolvedValue({ status: "ok", data: detail() });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  onChanged.mockReset();
  onBack.mockReset();
});

async function render() {
  await act(async () =>
    root.render(<PullRequestReview projectId={1} number={174} refreshKey={0} onBack={onBack} onChanged={onChanged} onReviewFiles={() => {}} />),
  );
}
const button = (name: string | RegExp) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    typeof name === "string" ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name : name.test(`${b.textContent} ${b.getAttribute("aria-label")}`),
  )!;
const click = (el: HTMLElement) => act(async () => el.click());

it("shows the author's avatar, an Open on GitHub button, and opens the pull request there", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await render();
  const avatar = host.querySelector<HTMLImageElement>(".pr-hero-meta img.avatar")!;
  expect(avatar.src).toBe("https://github.com/dependabot.png?size=40");
  await click(button("Open on GitHub"));
  expect(open).toHaveBeenCalledWith("https://github.com/me/oxide/pull/174");
});

it("folds the description away and reads all of it when opened", async () => {
  await render();
  expect(host.querySelector(".pr-description .md")).toBeNull();
  await click(button(/Description/));
  expect(host.querySelector(".pr-description .md")!.textContent).toContain("Updates from 3.14.21 to 3.14.22");
});

it("opens a failing check's run on GitHub", async () => {
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await render();
  await click(button(/web: Failed/));
  expect(open).toHaveBeenCalledWith("https://github.com/me/oxide/actions/runs/1");
});

it("lists conflicts and offers no merge while the branch conflicts", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({ status: "ok", data: detail({ mergeState: "conflicting", checks: [] }) });
  await render();
  expect(host.querySelector('[aria-label="Merge status"]')!.textContent).toContain("conflicts that must be resolved");
  expect(button(/Squash and merge/).disabled).toBe(true);
});

it("offers no merge while GitHub's branch policy blocks it, e.g. required checks still running", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ mergeState: "blocked", checks: [{ name: "web", state: "pending", url: null }] }),
  });
  await render();
  expect(button(/Squash and merge/).disabled).toBe(true);
});

it("turns on auto-merge while the checks run, and only then offers it", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ mergeState: "blocked", checks: [{ name: "web", state: "pending", url: null }] }),
  });
  await render();
  await click(button(/Merge when ready/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", false, true);
  expect(button(/Auto-merge on/).disabled).toBe(true);
  expect(onChanged).not.toHaveBeenCalled();
});

it("does not offer auto-merge when nothing is waiting", async () => {
  await render();
  expect([...host.querySelectorAll("button")].some((b) => /Merge when ready/.test(b.textContent ?? ""))).toBe(false);
});

it("preselects the merge method GitHub's own merge box would, not the first allowed", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(button(/and merge|merge commit/).textContent).toContain("Squash and merge");
  await click(button(/Squash and merge/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", false, false);
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("keeps the merge button coloured while merging, then confirms and returns to the list", async () => {
  let finish!: () => void;
  vi.spyOn(commands, "mergePullRequest").mockReturnValue(
    new Promise((resolve) => (finish = () => resolve({ status: "ok", data: null }))),
  );
  await render();
  await click(button(/Squash and merge/));
  const merging = button(/Merging/);
  expect(merging.disabled).toBe(true);
  expect(merging.classList.contains("pending")).toBe(true);
  await act(async () => finish());
  expect(onBack).toHaveBeenCalledWith("merged");
});

it("closes a pull request without merging it, then returns to the list", async () => {
  const close = vi.spyOn(commands, "closePullRequest").mockResolvedValue({ status: "ok", data: null });
  const merge = vi.spyOn(commands, "mergePullRequest");
  await render();
  await click(button(/^\s*Close /));
  expect(close).toHaveBeenCalledWith(1, 174);
  expect(merge).not.toHaveBeenCalled();
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onBack).toHaveBeenCalledWith("closed");
});

it("stays on the pull request and shows the error when closing fails", async () => {
  vi.spyOn(commands, "closePullRequest").mockResolvedValue({
    status: "error",
    error: { message: "Could not close" } as never,
  });
  await render();
  await click(button(/^\s*Close /));
  expect(host.querySelector(".pr-outcome")).toBeNull();
  expect(host.querySelector(".pr-error")!.textContent).toContain("Could not close");
  expect(onBack).not.toHaveBeenCalled();
});

it("keeps 'delete branch' in the merge options and sends the choice with the merge", async () => {
  const merge = vi.spyOn(commands, "mergePullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  await click(button("Merge options"));
  const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await click(button(/Squash and merge/));
  expect(merge).toHaveBeenCalledWith(1, 174, "squash", true, false);
});

it("takes a draft out of draft with one button", async () => {
  vi.mocked(commands.pullRequestDetail).mockResolvedValue({
    status: "ok",
    data: detail({ phase: "draft", pullRequest: { ...detail().pullRequest, draft: true } }),
  });
  const ready = vi.spyOn(commands, "setPullRequestDraft").mockResolvedValue({ status: "ok", data: null });
  await render();
  expect(host.textContent).toContain("This pull request is still a draft");
  expect(host.querySelector(".pr-merge .primary")!.textContent).toBe("Ready for review");
  await click(host.querySelector<HTMLButtonElement>(".pr-merge .primary")!);
  expect(ready).toHaveBeenCalledWith(1, 174, false);
  expect(commands.pullRequestDetail).toHaveBeenCalledTimes(2);
});

it("shows who reviews, who is assigned and labels, and assigns the viewer in one click", async () => {
  const edit = vi.spyOn(commands, "editPullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  const details = host.querySelector('[aria-label="Details"]')!;
  expect(details.textContent).toContain("bob");
  expect(details.querySelector('[aria-label="Requested changes"]')).not.toBeNull();
  expect(details.textContent).toContain("dependencies");
  await click(button("assign yourself"));
  expect(edit).toHaveBeenCalledWith(1, 174, expect.objectContaining({ addAssignees: ["me"], removeAssignees: [] }));
});

it("picks reviewers from the repository's people, without the author", async () => {
  vi.spyOn(commands, "pullRequestCandidates").mockResolvedValue({
    status: "ok",
    data: { users: ["ana", "app/dependabot", "bob"], labels: [] },
  });
  const edit = vi.spyOn(commands, "editPullRequest").mockResolvedValue({ status: "ok", data: null });
  await render();
  await click(button("Edit reviewers"));
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  expect(options.map((o) => o.textContent)).toEqual(["ana", "bob"]);
  await click(options[0].querySelector("button")!);
  expect(edit).toHaveBeenCalledWith(1, 174, expect.objectContaining({ addReviewers: ["ana"] }));
});

it("reads the conversation like the web: avatar, name, what they did and when", async () => {
  await render();
  const entries = Array.from(host.querySelectorAll(".pr-entry"));
  expect(entries).toHaveLength(2);
  expect(entries[0].querySelector("img.avatar")).not.toBeNull();
  expect(entries[0].querySelector("header")!.textContent).toContain("bob");
  expect(entries[0].querySelector("header")!.textContent).toContain("requested changes");
  expect(entries[1].querySelector("header")!.textContent).toContain("Author");
});
