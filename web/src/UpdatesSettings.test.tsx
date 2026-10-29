// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { commands, type UpdateStatus_Serialize as UpdateStatus } from "./bindings";
import { UpdatesSettings } from "./UpdatesSettings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const idle: UpdateStatus = { currentVersion: "0.1.0", version: null, notes: null, phase: "idle", downloaded: 0, total: null };
beforeEach(() => mockIPC(() => null));
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); clearMocks(); });
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent === name)!;

it("checks only on request and installs the checked update with download progress", async () => {
  let state = { ...idle };
  vi.spyOn(commands, "appUpdateStatus").mockImplementation(async () => state);
  const check = vi.spyOn(commands, "checkAppUpdate").mockImplementation(async () => {
    state = { ...idle, phase: "available", version: "0.2.0", notes: "Fixes and improvements." };
    return { status: "ok", data: state };
  });
  let finish: (() => void) | undefined;
  const install = vi.spyOn(commands, "installAppUpdate").mockImplementation((channel) => new Promise((resolve) => {
    state = { ...state, phase: "downloading", downloaded: 50, total: 100 };
    channel.onmessage(state);
    finish = () => { state = { ...state, phase: "installing" }; channel.onmessage(state); resolve({ status: "ok", data: null }); };
  }));
  await act(async () => root.render(<UpdatesSettings />));
  expect(host.textContent).toContain("Version 0.1.0");
  expect(check).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  await act(async () => button("Check for updates").click());
  expect(host.textContent).toContain("Oxide 0.2.0 is available");
  expect(install).not.toHaveBeenCalled();
  await act(async () => button("Download and install").click());
  expect(host.textContent).toContain("Downloading update… 50%");
  expect(button("Check for updates").disabled).toBe(true);
  await act(async () => finish!());
  expect(host.textContent).toContain("Installing update…");
});

it("distinguishes up-to-date from failed checks and allows installation retries", async () => {
  let state = { ...idle };
  vi.spyOn(commands, "appUpdateStatus").mockImplementation(async () => state);
  const check = vi.spyOn(commands, "checkAppUpdate").mockImplementationOnce(async () => {
    state = { ...idle, phase: "upToDate" }; return { status: "ok", data: state };
  }).mockImplementationOnce(async () => {
    state = { ...idle }; return { status: "error", error: { message: "Update feed unavailable. Try again." } };
  }).mockImplementation(async () => {
    state = { ...idle, phase: "available", version: "0.2.0" }; return { status: "ok", data: state };
  });
  const install = vi.spyOn(commands, "installAppUpdate").mockResolvedValue({ status: "error", error: { message: "Save your open files before installing the update." } });
  await act(async () => root.render(<UpdatesSettings />));
  await act(async () => button("Check for updates").click());
  expect(host.textContent).toContain("You’re up to date.");
  await act(async () => button("Check for updates").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  expect(host.textContent).not.toContain("You’re up to date.");
  await act(async () => button("Check for updates").click());
  await act(async () => button("Download and install").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Save your open files");
  expect(button("Download and install").disabled).toBe(false);
  expect(check).toHaveBeenCalledTimes(3);
  expect(install).toHaveBeenCalledOnce();
});
