// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { ReviewWorkKind } from "./bindings";
import { formatWait, formatWorkKind, ReviewLedgerSummary } from "./ReviewLedgerSummary";
import { ProjectOverview } from "./ProjectOverview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === name);

const entry = (pullRequest: number, waitSecs: number) => ({
  projectId: 1, threadId: pullRequest, pullRequest, provider: "claude", model: "sonnet",
  turnCompletedAt: 1_700_000_000, mergedAt: 1_700_000_000 + waitSecs,
});
const round = (provider: string, model: string | null, sampleSize: number, overrides: Partial<ReviewWorkKind> = {}) => ({
  provider, model, sampleSize,
  kind: { languages: ["rust"], sizeBand: "small" as const, issueLabels: ["backend"], ...overrides },
});
type Ledger = {
  medianSecs: number | null;
  count: number;
  entries: ReturnType<typeof entry>[];
  rounds: ReturnType<typeof round>[];
};
let ledger: Ledger;
let cleared: number;

beforeEach(() => {
  cleared = 0;
  ledger = { medianSecs: 3600, count: 2, entries: [entry(8, 7200), entry(7, 0)],
    rounds: [round("claude", "sonnet", 2), round("codex", "gpt-5", 1, { languages: ["typescript"], sizeBand: "large", issueLabels: [] })] };
  mockIPC((command) => {
    if (command === "review_ledger") return ledger;
    if (command === "clear_review_ledger") {
      cleared += 1;
      ledger = { medianSecs: null, count: 0, entries: [], rounds: [] };
      return null;
    }
    return null;
  });
});
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); vi.restoreAllMocks(); });

it("formats waits with their two largest units", () => {
  expect(formatWait(20)).toBe("under a minute");
  expect(formatWait(42 * 60)).toBe("42 min");
  expect(formatWait(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
  expect(formatWait(2 * 86400 + 4 * 3600)).toBe("2 d 4 h");
});

it("names the kind of work in a round group", () => {
  expect(formatWorkKind({ languages: ["rust", "typescript"], sizeBand: "medium", issueLabels: ["bug", "backend"] }))
    .toBe("rust, typescript · medium change · labels: bug, backend");
  expect(formatWorkKind({ languages: [], sizeBand: "small", issueLabels: [] }))
    .toBe("no language · small change");
});

it("shows the median, the recent entries, and review rounds by Provider with their sample size", async () => {
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  expect(host.textContent).toContain("Median wait from a finished Turn to the merge: 1 h");
  expect(host.textContent).toContain("#8");
  expect(host.textContent).toContain("2 h");
  expect(host.textContent).toContain("#7");
  expect(host.textContent).toContain("claude · sonnet");
  expect(host.textContent).toContain("rust · small change · labels: backend");
  expect(host.textContent).toContain("codex · gpt-5");
  expect(host.textContent).toContain("typescript · large change");
  expect(host.textContent).toContain("sample size: 2 rounds");
  expect(host.textContent).toContain("sample size: 1 round");
});

it("explains itself when there is no data", async () => {
  ledger = { medianSecs: null, count: 0, entries: [], rounds: [] };
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  expect(host.textContent).toContain("No merged pull requests yet");
  expect(host.textContent).toContain("No review rounds yet");
  expect(button("Clear ledger…")).toBeUndefined();
});

it("shows review rounds even before any pull request is merged", async () => {
  ledger = { medianSecs: null, count: 0, entries: [], rounds: [round("claude", "sonnet", 1)] };
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  expect(host.textContent).toContain("No merged pull requests yet");
  expect(host.textContent).toContain("sample size: 1 round");
  expect(button("Clear ledger…")).toBeDefined();
});

it("clears only after confirmation", async () => {
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  await act(async () => button("Clear ledger…")!.click());
  expect(cleared).toBe(0);
  await act(async () => button("Cancel")!.click());
  expect(cleared).toBe(0);
  await act(async () => button("Clear ledger…")!.click());
  await act(async () => button("Remove ledger")!.click());
  expect(cleared).toBe(1);
  expect(host.textContent).toContain("No merged pull requests yet");
  expect(host.textContent).toContain("No review rounds yet");
});

it("appears in the Project overview", async () => {
  const project = { id: 1, name: "Alpha", path: "/alpha", hidden: false, open: true, missing: false };
  await act(async () => root.render(
    <ProjectOverview project={project} threads={[]} onNewThread={() => {}} onOpenThread={() => {}}
      onOpenBoard={() => {}} onOpenDiff={() => {}} onOpenPullRequest={() => {}} />,
  ));
  expect(host.querySelector('[aria-label="Review ledger"]')).not.toBeNull();
  expect(host.textContent).toContain("#8");
  expect(host.textContent).toContain("sample size: 2 rounds");
});
