// @vitest-environment jsdom
import { act } from "react";
import { clearQueryCache, QUERY_STALE_MS } from "./queryCache";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type PullRequestDetail_Serialize } from "./bindings";
import { PullRequestPanel, REFRESH_INTERVAL_MS } from "./PullRequestPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "listPullRequests").mockResolvedValue({ status: "ok", data: [] });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = () =>
  act(async () =>
    root.render(<PullRequestPanel projectId={1} projectName="Oxide" threadId={7} refreshKey={0} onChanged={() => {}} onReviewFiles={() => {}} onFixPullRequest={async () => {}} />),
  );
const listCalls = () => vi.mocked(commands.listPullRequests).mock.calls.length;

it("opens creation from the Git header and keeps the form open after consuming its request", async () => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({ status: "ok", data: { branch: "topic", upstream: null, ahead: 1, behind: 0, added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: true, pickerDisabledReason: null } });
  vi.spyOn(commands, "pullRequestDraft").mockResolvedValue({ status: "ok", data: { title: "Topic", body: "", base: "main", head: "topic" } });
  vi.spyOn(commands, "pullRequestBaseBranches").mockResolvedValue({ status: "ok", data: ["main"] });
  const handled = vi.fn();
  const view = (request: number) => <PullRequestPanel projectId={1} projectName="Oxide" threadId={7} refreshKey={0} createRequest={request} onCreateHandled={handled} onChanged={() => {}} onReviewFiles={() => {}} onFixPullRequest={async () => {}} />;
  await act(async () => root.render(view(1)));
  expect(handled).toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Create pull request"]')).not.toBeNull();
  await act(async () => root.render(view(0)));
  expect(host.querySelector('[aria-label="Create pull request"]')).not.toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back to pull requests"]')!.click());
  expect(host.querySelector('[aria-label="Create pull request"]')).toBeNull();
  await act(async () => root.render(view(1)));
  expect(host.querySelector('[aria-label="Create pull request"]')).not.toBeNull();
});

it("shows the open pull requests without a branch tab or a manual reload button", async () => {
  await render();
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(host.querySelector('section[aria-label="Pull requests"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Reload from GitHub"]')).toBeNull();
});

it("reloads when the window regains focus", async () => {
  await render();
  const calls = listCalls();
  await act(async () => void window.dispatchEvent(new Event("focus")));
  expect(listCalls()).toBeGreaterThan(calls);
});

it("reloads periodically while visible, and not while hidden", async () => {
  vi.useFakeTimers();
  try {
    await render();
    let calls = listCalls();
    await act(async () => void vi.advanceTimersByTime(REFRESH_INTERVAL_MS));
    expect(listCalls()).toBeGreaterThan(calls);
    calls = listCalls();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => void vi.advanceTimersByTime(REFRESH_INTERVAL_MS * 2));
    expect(listCalls()).toBe(calls);
  } finally {
    vi.useRealTimers();
  }
});

const pr = (number: number, title: string) => ({
  number,
  title,
  author: "alice",
  url: "",
  head: "feat",
  base: "main",
  draft: false,
  createdAt: "2026-01-01T00:00:00Z",
});

const detail = (title: string): PullRequestDetail_Serialize => ({
  pullRequest: pr(1, title),
  phase: "open",
  body: "Full body from GitHub",
  headSha: "abc123",
  dossierOutOfDate: false,
  checks: [],
  comments: [],
  mergeState: "clean",
  reviewDecision: null,
  reviewers: [],
  assignees: [],
  labels: [],
  additions: 0,
  deletions: 0,
  viewer: "me",
  mergeMethods: ["merge"],
  defaultMergeMethod: "merge",
  deleteBranchOnMerge: false,
  diff: { base: "main", files: [] },
});

it("renders the previous list at once on remount without asking GitHub again while fresh", async () => {
  vi.mocked(commands.listPullRequests).mockResolvedValue({ status: "ok", data: [pr(1, "First PR")] });
  await render();
  const calls = listCalls();
  await act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(host.textContent).toContain("First PR");
  expect(host.textContent).not.toContain("Loading…");
  expect(listCalls()).toBe(calls);
});

it("revalidates an older cached list in the background while it stays on screen", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(commands.listPullRequests).mockResolvedValue({ status: "ok", data: [pr(1, "First PR")] });
    await render();
    await act(() => root.unmount());
    await act(async () => void vi.advanceTimersByTime(QUERY_STALE_MS + 1));
    root = createRoot(host);
    let resolve!: (r: Awaited<ReturnType<typeof commands.listPullRequests>>) => void;
    vi.mocked(commands.listPullRequests).mockImplementation(() => new Promise((r) => (resolve = r)));
    await render();
    expect(host.textContent).toContain("First PR");
    expect(host.textContent).not.toContain("Loading…");
    expect(listCalls()).toBe(2);
    await act(async () => resolve({ status: "ok", data: [pr(2, "Second PR")] }));
    expect(host.textContent).toContain("Second PR");
    expect(host.textContent).not.toContain("First PR");
  } finally {
    vi.useRealTimers();
  }
});

it("shows a pull request's header from the list while its detail is still loading", async () => {
  vi.mocked(commands.listPullRequests).mockResolvedValue({ status: "ok", data: [pr(1, "Instant header")] });
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok",
    data: { branch: "feat", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0,
      protected: false, unpublished: false, pickerDisabledReason: null },
  });
  vi.spyOn(commands, "pullRequestReviewThreads").mockResolvedValue({ status: "ok", data: [] });
  let resolveDetail!: (r: Awaited<ReturnType<typeof commands.pullRequestDetail>>) => void;
  vi.spyOn(commands, "pullRequestDetail").mockReturnValue(new Promise((r) => (resolveDetail = r)));
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());

  // The list's summary metadata renders the hero before the detail call lands.
  expect(host.querySelector(".pr-title")?.textContent).toContain("Instant header");
  expect(host.querySelector(".pr-row-author")?.textContent).toContain("alice");
  expect(host.querySelector(".skeleton")).not.toBeNull();

  await act(async () => resolveDetail({ status: "ok", data: detail("From GitHub") }));
  expect(host.querySelector(".pr-title")?.textContent).toContain("From GitHub");
});

it("keeps the list with a notice when a refresh fails", async () => {
  vi.mocked(commands.listPullRequests).mockResolvedValue({ status: "ok", data: [pr(1, "First PR")] });
  await render();
  vi.mocked(commands.listPullRequests).mockResolvedValue({ status: "error", error: { message: "offline" } });
  await act(async () => void window.dispatchEvent(new Event("focus")));
  expect(host.textContent).toContain("First PR");
  expect(host.textContent).toContain("offline");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
