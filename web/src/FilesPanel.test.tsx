// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { FilesPanel } from "./FilesPanel";
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); });
it("opens a file in Code and expands directories without mounting a small viewer", async () => {
  const open = vi.fn();
  const calls: string[] = [];
  mockIPC((command, args) => {
    calls.push(command);
    return (args as { path: string }).path === "" ? [{ path: "src", name: "src", isDir: true }] : [{ path: "src/app.ts", name: "app.ts", isDir: false }];
  });
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} onOpenFile={open} />));
  await act(async () => host.querySelector("button")!.click());
  expect(open).not.toHaveBeenCalled();
  await act(async () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("app.ts"))!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
  expect(calls).not.toContain("read_file");
  expect(host.querySelector(".files-viewer")).toBeNull();
});
