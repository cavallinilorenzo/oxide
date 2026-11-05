// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: () => <div /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const thread = { id: 2, projectId: 1, title: "Existing", provider: "claude", status: "completed", updatedAt: "2026-01-01T00:00:00Z" };
const file = {
  path: "src/a.ts", oldPath: null, status: "modified", added: 1, removed: 1, binary: false,
  hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "context", text: "keep" }, { kind: "removed", text: "old" }, { kind: "added", text: "new" }] }],
};

type Finding = {
  id: number;
  reviewThreadId: number;
  provider: string;
  path: string | null;
  side: "new" | "old" | null;
  line: number | null;
  code: string;
  body: string;
  plain: boolean;
  decision: "pending" | "kept" | "dismissed";
};

const calls: { command: string; args: Record<string, unknown> }[] = [];
let findings: Finding[];
let drafts: Record<string, unknown>[];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  drafts = [];
  findings = [
    {
      id: 10, reviewThreadId: 9, provider: "claude", path: "src/a.ts", side: "new", line: 2,
      code: "new", body: "Is this rename needed?", plain: false, decision: "pending",
    },
    {
      id: 11, reviewThreadId: 9, provider: "claude", path: null, side: null, line: null,
      code: "", body: "The reply could not be parsed.", plain: true, decision: "pending",
    },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "git_turn_diff" || command === "git_diff") return { base: null, files: [file] };
    if (command === "list_turn_picks") return [{ turnIndex: 0, prompt: "Existing", checkpointed: true }];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread];
    if (command === "list_blind_review_findings") return findings;
    if (command === "keep_blind_review_finding") {
      const finding = findings.find((f) => f.id === args.id && !f.plain)!;
      finding.decision = "kept";
      const comment = {
        id: 20, threadId: 2, scope: "uncommitted", path: finding.path, side: finding.side,
        line: finding.line, code: finding.code, body: finding.body, outdated: false, provider: "claude",
      };
      drafts.push(comment);
      return comment;
    }
    if (command === "dismiss_blind_review_finding") {
      findings.find((f) => f.id === args.id)!.decision = "dismissed";
      return null;
    }
    if (command === "list_line_comments") return drafts;
    if (command === "send_line_comments") { drafts = []; return null; }
    if (command === "plugin:event|listen") return 1;
    return null;
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

const press = (selector: string) => act(async () => host.querySelector<HTMLElement>(selector)!.click());

async function openDiff() {
  await act(async () => root.render(<App />));
  await press('[aria-label="Toggle tools panel"]');
  await press('[role="tab"][aria-label="Diff"]');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}

it("shows Blind review findings in the Diff, keeps the anchored one as a draft and dismisses the other", async () => {
  await openDiff();

  const list = host.querySelector('[aria-label="Blind review findings"]')!;
  expect(list).not.toBeNull();
  expect(list.textContent).toContain("claude review");
  expect(list.textContent).toContain("Is this rename needed?");
  expect(list.textContent).toContain("The reply could not be parsed.");
  expect(list.textContent).toContain("Plain text");

  await press('[aria-label="Keep finding 10"]');
  expect(calls.find((c) => c.command === "keep_blind_review_finding")?.args).toEqual({ id: 10 });

  await press('[aria-label="Dismiss finding 11"]');
  expect(calls.find((c) => c.command === "dismiss_blind_review_finding")?.args).toEqual({ id: 11 });

  // The kept finding is now a draft with the reviewing Provider's label.
  const draftsSection = host.querySelector('[aria-label="Line comments"]')!;
  expect(draftsSection.textContent).toContain("src/a.ts:2");
  expect(draftsSection.textContent).toContain("claude review");
  expect(draftsSection.textContent).toContain("Is this rename needed?");

  await press('[aria-label="Line comments"] .btn.primary');
  expect(calls.filter((c) => c.command === "send_line_comments")).toEqual([
    { command: "send_line_comments", args: { threadId: 2 } },
  ]);
});
