// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { PullRequestPanel } from "./PullRequestPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

it("shows the open pull requests without a branch tab and reloads on demand", async () => {
  await act(async () => root.render(<PullRequestPanel projectId={1} refreshKey={0}
    onChanged={() => {}} onReviewFiles={() => {}} />));
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(host.querySelector('section[aria-label="Pull requests"]')).not.toBeNull();
  const calls = vi.mocked(commands.listPullRequests).mock.calls.length;
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reload from GitHub"]')!.click());
  expect(vi.mocked(commands.listPullRequests).mock.calls.length).toBeGreaterThan(calls);
});
