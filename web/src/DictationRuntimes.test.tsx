// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands, type RuntimeCatalogue_Serialize as RuntimeCatalogue } from "./bindings";
import { DictationRuntimes, isNewer } from "./DictationRuntimes";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const changed = vi.fn();
const empty: RuntimeCatalogue = { protocolVersion: 1, installed: [], available: [], indexError: null, installing: [] };
const vulkan = { backend: "vulkan", version: "1.1.0", bytes: 52428800, requirements: "Vulkan 1.2 driver" } as const;
async function setup(data: RuntimeCatalogue) {
  const spy = vi.spyOn(commands, "dictationRuntimes").mockResolvedValue({ status: "ok", data });
  await act(async () => root.render(<DictationRuntimes onChanged={changed} />));
  return spy;
}
function button(name: string) { return [...host.querySelectorAll("button")].find(b => b.textContent === name); }
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); changed.mockClear(); });

it("compares versions numerically", () => {
  expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  expect(isNewer("1.0", "1.0.1")).toBe(false);
});

it("lists version, size and driver requirements, and installs with a refresh of the status", async () => {
  await setup({ ...empty, available: [vulkan] });
  expect(host.textContent).toContain("Available: 1.1.0 · 50.0 MiB");
  expect(host.textContent).toContain("Requires: Vulkan 1.2 driver");
  const install = vi.spyOn(commands, "dictationRuntimeInstall").mockResolvedValue({ status: "ok", data: { backend: "vulkan", version: "1.1.0", protocolVersion: 1, compatible: true, bytes: 1 } });
  await act(async () => button("Install Vulkan runtime")!.click());
  expect(install).toHaveBeenCalledWith("vulkan");
  expect(changed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("no restart needed");
});

it("offers an update only when the index has a newer version, and removes", async () => {
  const installed = { backend: "vulkan", version: "1.0.0", protocolVersion: 1, compatible: true, bytes: 1048576 } as const;
  await setup({ ...empty, installed: [installed], available: [vulkan] });
  expect(button("Update Vulkan runtime")).toBeDefined();
  expect(host.textContent).toContain("Update available");
  const remove = vi.spyOn(commands, "dictationRuntimeRemove").mockResolvedValue({ status: "ok", data: null });
  await act(async () => button("Remove Vulkan runtime")!.click());
  expect(remove).toHaveBeenCalledWith("vulkan");
  expect(changed).toHaveBeenCalled();
});

it("does not offer an update when the installed version is current", async () => {
  await setup({ ...empty, installed: [{ backend: "vulkan", version: "1.1.0", protocolVersion: 1, compatible: true, bytes: 1 }], available: [vulkan] });
  expect(button("Update Vulkan runtime")).toBeUndefined();
  expect(host.textContent).toContain("Installed");
});

it("shows an installed runtime with an incompatible protocol as an error, not silently", async () => {
  await setup({ ...empty, installed: [{ backend: "cuda", version: "0.9.0", protocolVersion: 2, compatible: false, bytes: 1 }] });
  const alert = host.querySelector('[role="alert"]')!.textContent!;
  expect(alert).toContain("protocol 2");
  expect(alert).toContain("not used");
  expect(button("Remove CUDA runtime")).toBeDefined();
});

it("shows hash, signature or protocol failures and keeps CPU usable", async () => {
  await setup({ ...empty, available: [vulkan] });
  vi.spyOn(commands, "dictationRuntimeInstall").mockResolvedValue({ status: "error", error: { message: "Runtime package hash does not match the index" } });
  await act(async () => button("Install Vulkan runtime")!.click());
  const alert = host.querySelector('[role="alert"]')!.textContent!;
  expect(alert).toContain("hash does not match");
  expect(alert).toContain("CPU is still available");
  expect(changed).not.toHaveBeenCalled();
});

it("shows progress, cancels, and reports cancellation as a notice", async () => {
  await setup({ ...empty, available: [vulkan] });
  let fail!: (v: { status: "error"; error: { message: string } }) => void;
  vi.spyOn(commands, "dictationRuntimeInstall").mockImplementation(() => new Promise(resolve => { fail = resolve; }));
  const cancel = vi.spyOn(commands, "dictationRuntimeCancel").mockResolvedValue(undefined);
  await act(async () => button("Install Vulkan runtime")!.click());
  expect(host.querySelector("progress")).not.toBeNull();
  await act(async () => button("Cancel Vulkan runtime download")!.click());
  expect(cancel).toHaveBeenCalledWith("vulkan");
  await act(async () => fail({ status: "error", error: { message: "Runtime download cancelled" } }));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("cancelled");
});

it("keeps installed runtimes visible when the index cannot be read", async () => {
  await setup({ ...empty, installed: [{ backend: "vulkan", version: "1.0.0", protocolVersion: 1, compatible: true, bytes: 1 }], indexError: "Runtime index signature is not valid" });
  expect(host.textContent).toContain("signature is not valid");
  expect(host.textContent).toContain("Installed: 1.0.0");
});
