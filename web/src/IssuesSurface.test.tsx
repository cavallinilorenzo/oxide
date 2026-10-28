// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type IssueDetail, type IssueSummary } from "./bindings";
import { IssuesSurface } from "./IssuesSurface";
import { clearQueryCache } from "./queryCache";
import { REFRESH_INTERVAL_MS } from "./useAutoRefresh";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

const summary = (over: Partial<IssueSummary> = {}): IssueSummary => ({
  number: 7,
  title: "Crash on startup",
  state: "OPEN",
  stateReason: "",
  author: "alice",
  url: "https://github.com/fake/repo/issues/7",
  commentsCount: 2,
  createdAt: "2026-01-01T00:00:00Z",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["bob"],
  ...over,
});

const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  ...summary(),
  body: "It **crashes**.",
  comments: [],
  viewer: "me",
  ...over,
});

beforeEach(() => {
  clearQueryCache();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "issuesState").mockResolvedValue({
    status: "ok",
    data: { availability: "ready", guidance: null },
  });
  vi.spyOn(commands, "issueTemplates").mockResolvedValue({ status: "ok", data: [] });
  vi.spyOn(commands, "listIssues").mockResolvedValue({ status: "ok", data: [summary()] });
  vi.spyOn(commands, "issueDetail").mockResolvedValue({ status: "ok", data: detail() });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = () => act(async () => root.render(<IssuesSurface projectId={1} />));
const listCalls = () => vi.mocked(commands.listIssues).mock.calls.length;
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;

it("lists issues with a full-width search and New issue, and no Refresh or Search button", async () => {
  await render();
  expect(host.querySelector('input[aria-label="Search issues"]')).not.toBeNull();
  expect(button("New issue")).toBeDefined();
  expect(button("Refresh")).toBeUndefined();
  expect(button("Search")).toBeUndefined();
  expect(host.textContent).toContain("Crash on startup");
  expect(host.textContent).toContain("bug");
});

it("reloads by itself on focus and on a timer while visible", async () => {
  vi.useFakeTimers();
  try {
    await render();
    let calls = listCalls();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(listCalls()).toBeGreaterThan(calls);
    calls = listCalls();
    await act(async () => void vi.advanceTimersByTime(REFRESH_INTERVAL_MS));
    expect(listCalls()).toBeGreaterThan(calls);
  } finally {
    vi.useRealTimers();
  }
});

it("filters closed issues and your own without a submit", async () => {
  await render();
  await act(async () => button("Closed").click());
  expect(commands.listIssues).toHaveBeenLastCalledWith(1, true, false, "");
  await act(async () => button("Mine").click());
  expect(commands.listIssues).toHaveBeenLastCalledWith(1, true, true, "");
});

it("searches as you type, after a short pause", async () => {
  vi.useFakeTimers();
  try {
    await render();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search issues"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "parser");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(commands.listIssues).not.toHaveBeenLastCalledWith(1, false, false, "parser");
    await act(async () => void vi.advanceTimersByTime(500));
    expect(commands.listIssues).toHaveBeenLastCalledWith(1, false, false, "parser");
  } finally {
    vi.useRealTimers();
  }
});

it("opens an issue and offers to close it, with the comment going along", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  expect(host.textContent).toContain("Crash on startup");
  expect(host.querySelector('[aria-label="Edit title"]')).not.toBeNull();
  await act(async () => button("Close as completed").click());
  expect(commands.closeIssue).toHaveBeenCalledWith(1, 7, "completed", "");
});

it("offers to reopen a closed issue", async () => {
  vi.spyOn(commands, "issueDetail").mockResolvedValue({
    status: "ok",
    data: detail({ state: "CLOSED", stateReason: "NOT_PLANNED" }),
  });
  vi.spyOn(commands, "reopenIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  expect(host.textContent).toContain("Closed as not planned");
  await act(async () => button("Reopen issue").click());
  expect(commands.reopenIssue).toHaveBeenCalledWith(1, 7);
});

const remount = async (projectId = 1) => {
  await act(() => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<IssuesSurface projectId={projectId} />));
};

it("shows the previous list at once on remount and swaps in the refreshed one", async () => {
  await render();
  let resolve!: (r: Awaited<ReturnType<typeof commands.listIssues>>) => void;
  vi.mocked(commands.listIssues).mockImplementation(() => new Promise((r) => (resolve = r)));
  const calls = listCalls();
  await remount();
  expect(host.textContent).not.toContain("Loading…");
  expect(host.textContent).toContain("Crash on startup");
  expect(listCalls()).toBe(calls + 1);
  await act(async () => resolve({ status: "ok", data: [summary({ number: 8, title: "Fresh one" })] }));
  expect(host.textContent).toContain("Fresh one");
  expect(host.textContent).not.toContain("Crash on startup");
});

it("remembers each filter's own result", async () => {
  await render();
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "ok", data: [summary({ title: "Old closed" })] });
  await act(async () => button("Closed").click());
  expect(host.textContent).toContain("Old closed");
  vi.mocked(commands.listIssues).mockImplementation(() => new Promise(() => {}));
  await act(async () => button("Open").click());
  expect(host.textContent).toContain("Crash on startup");
  expect(host.textContent).not.toContain("Loading…");
});

it("never shows one Project's issues in another", async () => {
  await render();
  vi.mocked(commands.listIssues).mockImplementation(() => new Promise(() => {}));
  await remount(2);
  expect(host.textContent).not.toContain("Crash on startup");
  expect(host.textContent).toContain("Loading…");
});

it("keeps the list and notes the failure when a refresh fails; a first failure shows the error", async () => {
  await render();
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "error", error: { message: "network down" } });
  await remount();
  expect(host.textContent).toContain("Crash on startup");
  expect(host.textContent).toContain("network down");
  expect(host.querySelector('[role="alert"]')).toBeNull();

  clearQueryCache();
  await remount();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("network down");
});

it("still shows the guidance when gh is not ready, even with a cached list", async () => {
  await render();
  vi.mocked(commands.issuesState).mockResolvedValue({
    status: "ok",
    data: { availability: "notAuthenticated", guidance: "Run gh auth login." },
  } as never);
  await remount();
  expect(host.textContent).toContain("Run gh auth login.");
  expect(host.textContent).not.toContain("Crash on startup");
});

it("lists issues without waiting for the readiness check", async () => {
  vi.mocked(commands.issuesState).mockImplementation(() => new Promise(() => {}));
  await render();
  expect(commands.listIssues).toHaveBeenCalled();
  expect(host.textContent).toContain("Crash on startup");
});

it("lists an issue created or closed here when coming back, without waiting for the timer", async () => {
  vi.spyOn(commands, "closeIssue").mockResolvedValue({ status: "ok", data: null });
  await render();
  await act(async () => (host.querySelector(".pr-row") as HTMLButtonElement).click());
  vi.mocked(commands.listIssues).mockResolvedValue({ status: "ok", data: [] });
  await act(async () => button("Close as completed").click());
  await act(async () => button("Issues").click());
  expect(host.textContent).toContain("No open issues.");
});
