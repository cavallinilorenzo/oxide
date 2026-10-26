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
  await act(async () => root.render(<GitHeader projectId={1} threadsKey="" onOpenDiff={() => {}} onOpenPullRequest={() => {}} onChanged={() => {}} />));
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
