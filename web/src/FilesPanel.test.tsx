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

const settle = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const buttonWith = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(text))!;
const dblclick = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });

function treeIpc() {
  const calls: string[] = [];
  mockIPC((command, args) => {
    if (command === "list_dir") {
      calls.push(command);
      return (args as { path: string }).path === ""
        ? [
            { path: "src", name: "src", isDir: true },
            { path: "README.md", name: "README.md", isDir: false },
          ]
        : [{ path: "src/app.ts", name: "app.ts", isDir: false }];
    }
    if (command === "find_files") return ["src/app.ts", "src/util.ts"];
    return null;
  });
  return calls;
}

it("selects a file on a single click and only opens it on a double click", async () => {
  const open = vi.fn();
  const calls = treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();

  expect(host.querySelector(".files-viewer")).toBeNull();
  await act(async () => buttonWith("src").click());
  await settle();
  await act(async () => buttonWith("app.ts").click());
  expect(open).not.toHaveBeenCalled();
  expect(buttonWith("app.ts").closest('[role="treeitem"]')?.getAttribute("aria-selected")).toBe("true");

  await dblclick(buttonWith("app.ts"));
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
  expect(calls).not.toContain("read_file");
});

it("finds files by name and opens a result from the keyboard", async () => {
  const open = vi.fn();
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();

  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(search, "app");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(150);

  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  const result = buttonWith("src/app.ts");
  await act(async () => {
    result.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(open).toHaveBeenCalledExactlyOnceWith("src/app.ts");
});

it("opens a focused file row from the keyboard with Enter or Space", async () => {
  const open = vi.fn();
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();
  await act(async () => buttonWith("src").click());
  await settle();

  const row = buttonWith("app.ts");
  await act(async () => row.focus());
  expect(open).not.toHaveBeenCalled();
  for (const key of ["Enter", " "]) {
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }
  expect(open).toHaveBeenNthCalledWith(1, "src/app.ts");
  expect(open).toHaveBeenNthCalledWith(2, "src/app.ts");
});

it("reloads the tree when the checkout revision changes", async () => {
  const calls = treeIpc();
  const open = vi.fn();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={open} />));
  await settle();
  expect(calls).toHaveLength(1);

  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={1} onOpenFile={open} />));
  await settle();
  expect(calls).toHaveLength(2);
});

it("collapses every expanded folder with one control", async () => {
  treeIpc();
  await act(async () => root.render(<FilesPanel projectId={1} threadId={null} revision={0} onOpenFile={vi.fn()} />));
  await settle();

  await act(async () => buttonWith("src").click());
  await settle();
  expect(buttonWith("app.ts")).toBeTruthy();

  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Collapse all folders"]')!.click());
  expect(buttonWith("app.ts")).toBeUndefined();
  expect(buttonWith("src")).toBeTruthy();
});
