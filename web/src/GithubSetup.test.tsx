// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands, type DeveloperTool_Serialize as DeveloperTool } from "./bindings";
import { GithubSetup } from "./GithubSetup";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); });

it("installs only on request, prevents overlapping installs and rechecks tools before continuing", async () => {
  const tools: DeveloperTool[] = ["git", "gh"].map((id) => ({ id, name: id === "git" ? "Git" : "GitHub CLI", installed: false, path: null, canInstall: true, documentation: "https://cli.github.com/" }));
  vi.spyOn(commands, "developerTools").mockImplementation(async () => ({ status: "ok", data: structuredClone(tools) }));
  let finish: (() => void) | undefined;
  const install = vi.spyOn(commands, "installDeveloperTool").mockImplementation((id) => new Promise((resolve) => { finish = () => { tools.find((t) => t.id === id)!.installed = true; resolve({ status: "ok", data: null }); }; }));
  const ready = vi.fn();
  await act(async () => root.render(<GithubSetup onReady={ready} />));
  expect(install).not.toHaveBeenCalled();
  const button = (name: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === name)!;
  await act(async () => button("Install Git").click());
  expect(button("Install GitHub CLI").disabled).toBe(true);
  expect(button("Check again").disabled).toBe(true);
  await act(async () => finish!());
  expect(container.textContent).toContain("Installed");
  await act(async () => button("Check again").click());
  expect(ready).not.toHaveBeenCalled();
  await act(async () => button("Install GitHub CLI").click());
  await act(async () => finish!());
  await act(async () => button("Check again").click());
  expect(ready).toHaveBeenCalledOnce();
  expect(install.mock.calls).toEqual([["git"], ["gh"]]);
});

it("keeps installation failures recoverable and opens official guides when no package manager exists", async () => {
  const tool: DeveloperTool = { id: "gh", name: "GitHub CLI", installed: false, path: null, canInstall: true, documentation: "https://cli.github.com/" };
  vi.spyOn(commands, "developerTools").mockImplementation(async () => ({ status: "ok", data: [{ ...tool }] }));
  vi.spyOn(commands, "installDeveloperTool").mockResolvedValue({ status: "error", error: { message: "Connection failed. Try again." } });
  const open = vi.spyOn(commands, "openLink").mockResolvedValue({ status: "ok", data: null });
  await act(async () => root.render(<GithubSetup />));
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Install GitHub CLI")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection failed");
  tool.canInstall = false;
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Check again")!.click());
  await act(async () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Installation guide"))!.click());
  expect(open).toHaveBeenCalledWith(tool.documentation);
});
