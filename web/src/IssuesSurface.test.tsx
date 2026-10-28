// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type IssueDetail, type IssueSummary } from "./bindings";
import { IssuesSurface } from "./IssuesSurface";
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
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(commands, "issuesState").mockResolvedValue({
    status: "ok",
    data: { availability: "ready", guidance: null },
  });
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
