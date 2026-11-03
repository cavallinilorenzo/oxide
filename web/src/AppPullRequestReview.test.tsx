// @vitest-environment jsdom
// The real App, the real Diff Surface and the real review-draft panel, driven through the
// deterministic Tauri IPC harness: a review comments inline drafts on the PR scope, submits them
// as one GitHub review, and refreshes what GitHub says about the pull request.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";
import { patchDocument, type CodeOpenRequest } from "./codeOpen";
import { CommentComposer } from "./CommentComposer";

// Monaco does not run in jsdom: the workbench is a stand-in that offers the same composer on line
// 5 of the patch.
vi.mock("./CodeWorkbench", () => ({
  CodeWorkbench: ({ openRequest, projectId }: { openRequest: CodeOpenRequest | null; projectId: number }) =>
    openRequest?.diff && openRequest.review ? (
      <CommentComposer projectId={projectId} path={openRequest.path} patch={patchDocument(openRequest.diff)} line={5} review={openRequest.review} onClose={() => {}} />
    ) : null,
}));
vi.mock("./ThreadView", () => ({ ThreadView: () => <div /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Oxide", path: "/repo", hidden: false, open: true, missing: false };
const thread = { id: 2, projectId: 1, title: "Existing", provider: "claude", status: "completed", updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", branch: "feat-alpha", worktreePath: "/repo-feat-alpha", issueNumber: null };
const pullRequest = { number: 5, title: "Fix the thing", url: "https://github.com/me/repo/pull/5", draft: false, base: "main", head: "remote-topic", author: "alice", createdAt: "2026-01-01T00:00:00Z" };
const file = {
  path: "src/app.rs", oldPath: null, status: "modified" as const, added: 1, removed: 1, binary: false,
  hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "context" as const, text: "keep" }, { kind: "removed" as const, text: "old" }, { kind: "added" as const, text: "new" }] }],
};
const detail = {
  pullRequest, phase: "open", body: "", comments: [], mergeState: "clean", reviewDecision: null, reviewers: [], assignees: [],
  labels: [], additions: 1, deletions: 1, viewer: "me", mergeMethods: ["merge"], defaultMergeMethod: "merge", deleteBranchOnMerge: false,
  checks: [], diff: { base: "main", files: [file] },
};

type Args = Record<string, unknown>;
const calls: { command: string; args: Args }[] = [];
const called = (command: string) => calls.filter((call) => call.command === command).map((call) => call.args);
let drafts: Record<string, unknown>[];
let reviewSubmitted: number;
let reviewError: string | null;

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  drafts = [];
  reviewSubmitted = 0;
  reviewError = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Args;
    calls.push({ command, args });
    switch (command) {
      case "list_projects": case "rescan_projects": return [project];
      case "last_selection": return { projectId: 1, threadId: 2 };
      case "list_threads": return [thread];
      case "git_status": return { branch: "feat-alpha", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, protected: false, unpublished: false, pickerDisabledReason: null };
      case "git_diff": case "git_turn_diff": return { base: null, files: [] };
      case "list_pull_requests": return [pullRequest];
      case "pull_request_detail": return {
        ...detail,
        reviewDecision: reviewSubmitted > 0 ? "changesRequested" : null,
        comments: reviewSubmitted > 0
          ? [{ author: "me", body: "Please fix both.", createdAt: "2026-01-01T00:00:00Z", review: "changesRequested" }]
          : [],
      };
      case "pull_request_review_threads": return reviewSubmitted > 0
        ? [{ id: "t1", path: "src/app.rs", line: 1, originalLine: 1, side: "new", resolved: false, outdated: false, diffHunk: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n", comments: [{ author: "me", body: "Please fix both.", createdAt: "2026-01-01T00:00:00Z" }] }]
        : [];
      case "list_pull_request_line_comments": return drafts;
      case "add_pull_request_line_comment": {
        const saved = { id: drafts.length + 1, projectId: 1, pullRequest: 5, ...(args.comment as Args) };
        drafts.push(saved);
        return saved;
      }
      case "edit_pull_request_line_comment": {
        const draft = drafts.find((candidate) => candidate.id === args.id)!;
        draft.body = args.body;
        return null;
      }
      case "delete_pull_request_line_comment":
        drafts = drafts.filter((candidate) => candidate.id !== args.id);
        return null;
      case "submit_pull_request_review":
        if (reviewError) throw { message: reviewError };
        drafts = [];
        reviewSubmitted += 1;
        return null;
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

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
};
const byText = (text: string, selector = "button") => [...host.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim().includes(text));
const type = (element: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });

/** Opens the pull request and its PR Diff scope. */
async function openPullRequestDiff() {
  await act(async () => root.render(<App />));
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Toggle tools panel"]')).not.toBeNull());
  await click(host.querySelector('[aria-label="Toggle tools panel"]'));
  await click(host.querySelector('[role="tab"][aria-label="Pull request"]'));
  await vi.waitFor(() => expect(byText("Fix the thing")).toBeTruthy());
  await click(byText("Fix the thing"));
  await vi.waitFor(() => expect(byText("Review files")).toBeTruthy());
  await click(byText("Review files"));
  await vi.waitFor(() => expect(host.querySelector('[role="option"]')).not.toBeNull());
}

it("drafts inline comments on the PR scope and submits them as one review", async () => {
  await openPullRequestDiff();

  // The PR scope offers the same line composer as a Thread's Diff, writing a draft for the review.
  await click(host.querySelector('[role="option"]'));
  await vi.waitFor(() => expect(host.querySelector('form[aria-label="Comment on line"] textarea[aria-label="Comment"]')).not.toBeNull());
  await type(host.querySelector<HTMLTextAreaElement>('form[aria-label="Comment on line"] textarea[aria-label="Comment"]')!, "Why was this renamed?");
  await click(host.querySelector('form[aria-label="Comment on line"] button[type="submit"]'));
  expect(called("add_pull_request_line_comment")).toEqual([{
    projectId: 1,
    pullRequest: 5,
    comment: { path: "src/app.rs", side: "old", line: 2, code: "old", body: "Why was this renamed?" },
  }]);

  await click(host.querySelector('[role="tab"][aria-label="Diff"]'));
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Pull request review"]')).not.toBeNull());
  const section = host.querySelector('[aria-label="Pull request review"]')!;
  expect(section.textContent).toContain("src/app.rs:2");
  expect(section.textContent).toContain("Why was this renamed?");
  // Nothing reached GitHub yet: the comment is still a draft.
  expect(called("submit_pull_request_review")).toEqual([]);

  const refreshes = called("pull_request_review_threads").length;
  const decisions = called("pull_request_detail").length;
  await type(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review summary"]')!, "Please fix both.");
  await click(byText("Request changes"));
  expect(called("submit_pull_request_review")).toEqual([{
    projectId: 1,
    number: 5,
    verdict: "requestChanges",
    summary: "Please fix both.",
  }]);

  // The draft is gone, the summary cleared, and GitHub's threads and decision were reloaded.
  await vi.waitFor(() => expect(host.querySelector(".line-comment-list")).toBeNull());
  expect(host.querySelector('[aria-label="Pull request review"]')!.textContent).not.toContain("Why was this renamed?");
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review summary"]')!.value).toBe("");
  await vi.waitFor(() => expect(called("pull_request_review_threads").length).toBeGreaterThan(refreshes));
  await vi.waitFor(() => expect(called("pull_request_detail").length).toBeGreaterThan(decisions));
  expect(host.textContent).toContain("Please fix both.");
});

it("offers an approval without an inline draft", async () => {
  await openPullRequestDiff();
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Pull request review"]')).not.toBeNull());
  await click(byText("Approve"));
  expect(called("submit_pull_request_review")).toEqual([{
    projectId: 1,
    number: 5,
    verdict: "approve",
    summary: "",
  }]);
});

it("shows GitHub's refusal and keeps the drafts", async () => {
  reviewError = "Can not approve your own pull request (HTTP 422)";
  drafts = [{ id: 1, projectId: 1, pullRequest: 5, path: "src/app.rs", side: "new", line: 1, code: "run();", body: "Needs a guard." }];
  await openPullRequestDiff();

  await vi.waitFor(() => expect(host.querySelector('[aria-label="Pull request review"]')).not.toBeNull());
  await click(byText("Approve"));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("Can not approve your own pull request"));
  expect(host.querySelector('[aria-label="Pull request review"]')!.textContent).toContain("Needs a guard.");
  expect(called("submit_pull_request_review")).toHaveLength(1);
});
