// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { formatWait, ReviewLedgerSummary } from "./ReviewLedgerSummary";
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
let ledger: { medianSecs: number | null; count: number; entries: ReturnType<typeof entry>[] };
let cleared: number;

beforeEach(() => {
  cleared = 0;
  ledger = { medianSecs: 3600, count: 2, entries: [entry(8, 7200), entry(7, 0)] };
  mockIPC((command) => {
    if (command === "review_ledger") return ledger;
    if (command === "clear_review_ledger") {
      cleared += 1;
      ledger = { medianSecs: null, count: 0, entries: [] };
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

it("shows the median and the recent entries", async () => {
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  expect(host.textContent).toContain("Median wait from a finished Turn to the merge: 1 h");
  expect(host.textContent).toContain("#8");
  expect(host.textContent).toContain("2 h");
  expect(host.textContent).toContain("#7");
});

it("explains itself when there is no data", async () => {
  ledger = { medianSecs: null, count: 0, entries: [] };
  await act(async () => root.render(<ReviewLedgerSummary projectId={1} />));
  expect(host.textContent).toContain("No merged pull requests yet");
  expect(button("Clear ledger…")).toBeUndefined();
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
});

it("appears in the Project overview", async () => {
  const project = { id: 1, name: "Alpha", path: "/alpha", hidden: false, open: true, missing: false };
  await act(async () => root.render(
    <ProjectOverview project={project} threads={[]} onNewThread={() => {}} onOpenThread={() => {}}
      onOpenBoard={() => {}} onOpenDiff={() => {}} onOpenPullRequest={() => {}} />,
  ));
  expect(host.querySelector('[aria-label="Review ledger"]')).not.toBeNull();
  expect(host.textContent).toContain("#8");
});
