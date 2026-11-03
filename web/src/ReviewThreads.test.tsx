// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Diff, PullRequestReviewThread } from "./bindings";
import { ReviewThreads } from "./ReviewThreads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

const thread = (overrides: Partial<PullRequestReviewThread> = {}): PullRequestReviewThread => ({
  id: "t1",
  path: "src/app.rs",
  line: 2,
  originalLine: 2,
  side: "new",
  resolved: false,
  outdated: false,
  diffHunk: "@@ -1,2 +1,3 @@\n fn main() {\n+    run();\n",
  comments: [{ author: "alice", body: "This needs a guard.", createdAt: "2026-01-01T00:00:00Z" }],
  ...overrides,
});

const diff: Diff = {
  base: "main",
  files: [
    {
      path: "src/app.rs",
      oldPath: null,
      status: "modified",
      added: 1,
      removed: 0,
      binary: false,
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          lines: [
            { kind: "context", text: "fn main() {" },
            { kind: "added", text: "    run();" },
          ],
        },
      ],
    },
  ],
};

const render = (threads: PullRequestReviewThread[]) =>
  act(async () => root.render(<ReviewThreads diff={diff} threads={threads} />));
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement).click());

it("puts a review thread on its line with its author, comment and code", async () => {
  await render([thread()]);
  const section = host.querySelector('[aria-label="Review threads"]');
  expect(section?.textContent).toContain("src/app.rs:2");
  expect(section?.textContent).toContain("    run();");
  expect(section?.textContent).toContain("@alice");
  expect(section?.textContent).toContain("This needs a guard.");
});

it("marks a resolved thread, keeps it short until asked, and marks an outdated one", async () => {
  await render([
    thread({ id: "resolved", resolved: true }),
    thread({ id: "outdated", line: 1, outdated: true, comments: [{ author: "bob", body: "Old note.", createdAt: "2026-01-01T00:00:00Z" }] }),
  ]);
  expect(host.textContent).toContain("Resolved");
  expect(host.textContent).toContain("Outdated");
  // The resolved thread shows only its summary until expanded.
  expect(host.textContent).not.toContain("This needs a guard.");
  const toggle = host.querySelector('[aria-expanded="false"]');
  expect(toggle?.textContent).toContain("@alice");
  await click(toggle);
  expect(host.textContent).toContain("This needs a guard.");
});

it("keeps a thread whose line the diff lost reachable under its own heading", async () => {
  await render([
    thread({ id: "lost", path: "src/old.rs", line: null, originalLine: 40, outdated: true }),
  ]);
  const lost = host.querySelector('[aria-label="Review threads not in this diff"]');
  expect(lost?.textContent).toContain("src/old.rs:40");
  expect(lost?.textContent).toContain("This needs a guard.");
});

it("renders nothing when the pull request has no review threads", async () => {
  await render([]);
  expect(host.querySelector('[aria-label="Review threads"]')).toBeNull();
});
