// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { GitHeader } from "./GitHeader";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("dismisses branch and Git action menus on outside pointer and Escape", async () => {
  const status = { branch: "main", upstream: null, ahead: 0, behind: 0, added: 1, removed: 0, changedFiles: 1, pickerDisabledReason: null, protected: true, unpublished: false };
  vi.spyOn(commands, "gitStatus").mockResolvedValue({ status: "ok", data: status });
  vi.spyOn(commands, "fetchProject").mockResolvedValue({ status: "ok", data: true });
  vi.spyOn(commands, "listBranches").mockResolvedValue({ status: "ok", data: [] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<GitHeader projectId={1} threadId={7} threadsKey="" onOpenDiff={() => {}} onOpenPullRequest={() => {}} onChanged={() => {}} />));
  const branch = host.querySelector<HTMLButtonElement>(".branch-button")!;
  await act(async () => branch.click());
  expect(host.querySelector(".branch-menu")).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(host.querySelector(".branch-menu")).toBeNull();
  const actions = host.querySelector<HTMLButtonElement>(".git-menu-toggle")!;
  await act(async () => actions.click());
  expect(host.querySelector(".git-menu")).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector(".git-menu")).toBeNull();
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks();
});

const baseStatus = { branch: "main", upstream: null, ahead: 0, behind: 0, added: 0, removed: 0, changedFiles: 0, pickerDisabledReason: null, protected: false, unpublished: false };

function setup() {
  vi.spyOn(commands, "fetchProject").mockResolvedValue({ status: "ok", data: true });
  vi.spyOn(commands, "listBranches").mockResolvedValue({ status: "ok", data: [] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const view = (threadId: number) => (
    <GitHeader projectId={1} threadId={threadId} threadsKey="" onOpenDiff={() => {}} onOpenPullRequest={() => {}} onChanged={() => {}} />
  );
  const cleanup = async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); };
  return { host, root, view, cleanup };
}

it("sends the displayed Thread with every status, branch and pull request", async () => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({ status: "ok", data: { ...baseStatus, behind: 2, upstream: "origin/topic" } });
  const pull = vi.spyOn(commands, "pull").mockResolvedValue({ status: "ok", data: null });
  const { host, root, view, cleanup } = setup();
  await act(async () => root.render(view(7)));
  expect(commands.gitStatus).toHaveBeenCalledWith(1, 7);
  await act(async () => host.querySelector<HTMLButtonElement>(".pull-button")!.click());
  expect(pull).toHaveBeenCalledWith(1, 7);
  await act(async () => host.querySelector<HTMLButtonElement>(".branch-button")!.click());
  expect(commands.listBranches).toHaveBeenCalledWith(1, 7);
  await cleanup();
});

it("ignores a late status of a deselected Thread and drops its open menu", async () => {
  let resolveOld!: (value: Awaited<ReturnType<typeof commands.gitStatus>>) => void;
  const status = vi.spyOn(commands, "gitStatus").mockImplementation((_project, thread) =>
    thread === 7
      ? new Promise((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ status: "ok", data: { ...baseStatus, branch: "beta" } }),
  );
  const { host, root, view, cleanup } = setup();
  await act(async () => root.render(view(7)));
  await act(async () => root.render(view(8)));
  expect(status).toHaveBeenCalledWith(1, 8);
  expect(host.querySelector(".branch-name")?.textContent).toBe("beta");
  await act(async () => resolveOld({ status: "ok", data: { ...baseStatus, branch: "alpha" } }));
  expect(host.querySelector(".branch-name")?.textContent).toBe("beta");
  await cleanup();
});

it("discards an unsubmitted push dialog when another Thread is selected", async () => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({ status: "ok", data: { ...baseStatus, ahead: 1, protected: true } });
  const push = vi.spyOn(commands, "push").mockResolvedValue({ status: "ok", data: null });
  const { host, root, view, cleanup } = setup();
  await act(async () => root.render(view(7)));
  await act(async () => host.querySelector<HTMLButtonElement>(".git-primary")!.click());
  expect(document.querySelector("[aria-label='Push to main']")).not.toBeNull();
  await act(async () => root.render(view(8)));
  expect(document.querySelector("[aria-label='Push to main']")).toBeNull();
  expect(push).not.toHaveBeenCalled();
  await cleanup();
});

it("shows a failed status load instead of a stale or main-checkout branch", async () => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({ status: "error", error: { message: "The checkout of Thread 7 is missing" } });
  const { host, root, view, cleanup } = setup();
  await act(async () => root.render(view(7)));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("missing");
  expect(host.querySelector(".branch-button")).toBeNull();
  await cleanup();
});
