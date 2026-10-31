// @vitest-environment jsdom
// The real App with the real Pull request and Issues Surfaces, driven through the deterministic
// Tauri IPC harness: repository lists stay Project-scoped, branch actions name and target the
// selected Thread's checkout, and Threads started from GitHub open in the single window.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: ({ threadId, draft }: { threadId: number; draft: string }) => <div data-thread={threadId}>{draft}</div> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Oxide", path: "/repo", hidden: false, open: true, missing: false };
const thread = (id: number, title: string, branch: string | null) => ({
  id, projectId: 1, provider: "claude", title, status: "completed", updatedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", branch, worktreePath: branch ? `/repo-${branch}` : null, issueNumber: null,
});
const threads = [thread(2, "Alpha work", "feat-alpha"), thread(3, "Beta work", "feat-beta"), thread(4, "Chat", null)];
const pullRequest = { number: 5, title: "Fix the thing", url: "https://github.com/me/repo/pull/5", draft: false, base: "main", head: "remote-topic", author: "alice", createdAt: "2026-01-01T00:00:00Z" };
const prDetail = {
  pullRequest, phase: "open", body: "", comments: [], mergeState: "conflicting", reviewDecision: null, reviewers: [], assignees: [],
  labels: [], additions: 1, deletions: 0, viewer: "me", mergeMethods: ["merge"], defaultMergeMethod: "merge", deleteBranchOnMerge: false,
  checks: [{ name: "web", state: "failure", url: null, required: true }], diff: { base: "main", files: [] },
};
const issue = { number: 9, title: "Crash on start", state: "OPEN", stateReason: "", author: "alice", url: "https://github.com/me/repo/issues/9", commentsCount: 0, createdAt: "2026-01-01T00:00:00Z", labels: [], assignees: [] };

const calls: { command: string; args: Record<string, unknown> }[] = [];
const called = (command: string) => calls.filter((call) => call.command === command).map((call) => call.args);
let selection: { projectId: number; threadId: number | null };
let fail: string | null;

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  fail = null;
  selection = { projectId: 1, threadId: 2 };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return selection;
      case "list_threads": return selection.threadId === null ? [] : threads;
      case "git_diff": case "git_turn_diff": return { base: "main", files: [] };
      case "git_status": {
        const owner = threads.find((t) => t.id === args.threadId);
        return { branch: owner ? owner.branch ?? "main" : "main", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false, pickerDisabledReason: null };
      }
      case "list_pull_requests": return [pullRequest];
      case "pull_request_detail": return prDetail;
      case "checkout_pull_request": if (fail) throw { message: fail }; return null;
      case "issues_state": return { availability: "ready", guidance: null };
      case "list_issues": return [issue];
      case "issue_detail": return { ...issue, body: "It crashes.", comments: [], viewer: "me" };
      case "list_branches": return [{ name: "main", current: true, remote: false }];
      case "get_settings": return { settings: { defaultProvider: "codex", providers: { codex: { model: "gpt-5", effort: "high", permissionMode: "ask" } } }, errors: [] };
      case "dispatch_thread": return { ...thread(9, "Crash on start", "issue-9"), issueNumber: 9 };
      case "create_thread": return { ...thread(10, "", null), provider: "codex" };
      case "plugin:event|listen": return 1;
      default: return null;
    }
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

/** Lets the IPC round trips and their renders finish. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await settle();
};
const byText = (text: string, selector = "button") => [...host.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim().includes(text));
const text = () => host.textContent ?? "";

async function open(tab: "Pull request" | "Issues") {
  await act(async () => root.render(<App />));
  await settle();
  await click(host.querySelector('[aria-label="Toggle tools panel"]'));
  await click(host.querySelector(`[role="tab"][aria-label="${tab}"]`));
}

it("labels the pull request list by repository and branch actions by the selected Thread's checkout", async () => {
  await open("Pull request");
  expect(host.querySelector(".pr-scope-title")?.textContent).toContain("Oxide");
  expect(host.querySelector('[aria-label="Branch actions"]')?.textContent).toContain("feat-alpha");
  expect(called("git_status").some((args) => args.threadId === 2)).toBe(true);
  // The list is repository-wide: it was asked for the Project, with no Thread.
  expect(called("list_pull_requests")[0]).not.toHaveProperty("threadId");

  await click(byText("Beta work"));
  expect(host.querySelector('[aria-label="Branch actions"]')?.textContent).toContain("feat-beta");
  expect(host.querySelector(".pr-scope-title")?.textContent).toContain("Oxide");
});

it("dismisses an unsubmitted create form when another Thread is selected", async () => {
  await open("Pull request");
  await click(byText("New pull request"));
  expect(host.querySelector('[aria-label="Create pull request"]')).not.toBeNull();
  await click(byText("Beta work"));
  expect(host.querySelector('[aria-label="Create pull request"]')).toBeNull();
  expect(called("create_pull_request")).toEqual([]);
});

it("opens a remote review without checking anything out, and checks out only in the selected Thread's checkout", async () => {
  await open("Pull request");
  await click(byText("Fix the thing"));
  expect(text()).toContain("remote-topic");
  // Reading the remote review changed no checkout and asked for Git of the selected Thread only.
  expect(called("checkout_pull_request")).toEqual([]);
  expect(called("git_status").every((args) => args.threadId === 2)).toBe(true);

  await click(byText("Review files"));
  expect(host.querySelector('[role="tab"][aria-label="Diff"]')?.getAttribute("aria-selected")).toBe("true");
  expect(text()).toContain("PR #5");
  expect(called("checkout_pull_request")).toEqual([]);

  await click(host.querySelector('[role="tab"][aria-label="Pull request"]'));
  await click(byText("Check out"));
  expect(called("checkout_pull_request")).toEqual([{ projectId: 1, threadId: 2, number: 5 }]);
});

it("explains a failed local checkout instead of falling back to another checkout", async () => {
  fail = "Git refused: local changes";
  await open("Pull request");
  await click(byText("Fix the thing"));
  await click(byText("Check out"));
  expect(text()).toContain("Git refused: local changes");
  expect(called("checkout_pull_request")).toEqual([{ projectId: 1, threadId: 2, number: 5 }]);
});

it("explains the missing selection instead of acting on the main checkout", async () => {
  selection = { projectId: 1, threadId: null };
  await open("Pull request");
  const create = byText("New pull request") as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(host.querySelector('[aria-label="Branch actions"]')?.textContent).toContain("Select a Thread");
  await click(byText("Fix the thing"));
  expect((byText("Check out") as HTMLButtonElement).disabled).toBe(true);
  expect(text()).toContain("Select a Thread to check this branch out");
  expect(called("git_status").some((args) => args.threadId == null)).toBe(false);
});

it("starts a Thread from an Issue and selects it in the same window", async () => {
  await open("Issues");
  expect(host.querySelector(".pr-scope-title")?.textContent).toContain("Oxide");
  await click(byText("Crash on start"));
  await click(byText("Start thread from issue"));
  const form = document.querySelector<HTMLFormElement>('[role="dialog"][aria-label="Dispatch a task"]')!;
  await act(async () => form.requestSubmit());
  expect(called("dispatch_thread")).toHaveLength(1);
  expect(host.querySelector('[data-thread="9"]')).not.toBeNull();
  expect(host.querySelector('[role="tab"][aria-label="Issues"]')?.getAttribute("aria-selected")).toBe("true");
});

it("starts a fix Thread from a failing pull request and selects it", async () => {
  await open("Pull request");
  await click(byText("Fix the thing"));
  await click(byText("Fix PR"));
  expect(called("create_thread")).toHaveLength(1);
  expect(called("send_prompt")[0]?.threadId).toBe(10);
  expect(host.querySelector('[data-thread="10"]')).not.toBeNull();
});
