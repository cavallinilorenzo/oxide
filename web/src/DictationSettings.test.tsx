// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands, type DictationModelCatalogue, type DictationSettings as Value } from "./bindings";
import { DictationSettings } from "./DictationSettings";
import rawCatalogue from "../../crates/oxide-core/src/dictation/catalogue.json";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const catalogue: DictationModelCatalogue = JSON.parse(JSON.stringify(rawCatalogue));
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const changed = vi.fn();
async function setup(value: Value = { enabled: false, language: "it", device: "cpu", model: "small" }) {
  vi.spyOn(commands, "dictationStatus").mockResolvedValue({ status: "ok", data: { installed: true, gpuCompiled: false, availableMemoryGb: null, cpuThreads: 4, recommendation: "Insufficient data", manifest: { whisperRsVersion: "test", whisperCppPinned: "test", includedBackends: ["cpu"] }, probes: [{ backend: "cpu", adapter: null, state: { status: "available" } }], lastExecution: null } });
  vi.spyOn(commands, "dictationModelCatalogue").mockResolvedValue(catalogue);
  vi.spyOn(commands, "dictationModels").mockResolvedValue({ status: "ok", data: catalogue.models.map(({ id }) => ({ id, state: { status: id === "small" ? "installed" : "missing" } })) });
  await act(async () => root.render(<DictationSettings value={value} onChange={changed} />));
}
function button(name: string) { return [...host.querySelectorAll("button")].find(b => b.textContent === name)!; }
afterEach(async () => { await act(async () => root.render(null)); vi.restoreAllMocks(); changed.mockClear(); });
it("keeps the migrated Small selection and multilingual language until an installed model is explicitly selected", async () => {
  await setup();
  expect(host.textContent).toContain("large-v3-turbo");
  expect(host.textContent).toContain("Memory estimate");
  expect(host.textContent).toContain("Unknown");
  expect(changed).not.toHaveBeenCalled();
  expect(button("Select tiny")).toBeUndefined();
  await act(async () => button("Select small").click());
  expect(changed).toHaveBeenCalledWith({ enabled: false, language: "it", device: "cpu", model: "small" });
});

it("downloads explicitly, blocks duplicate starts and never selects on async completion", async () => {
  await setup();
  let finish!: (value: { status: "ok"; data: null }) => void;
  const install = vi.spyOn(commands, "dictationModelInstall").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(commands, "dictationModelStatus").mockResolvedValue({ status: "ok", data: { id: "tiny", state: { status: "installed" } } });
  const download = button("Download tiny");
  await act(async () => { download.click(); download.click(); });
  expect(install).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  vi.spyOn(commands, "dictationAdvice").mockResolvedValue(await commands.dictationStatus());
  await act(async () => finish({ status: "ok", data: null }));
  expect(button("Select tiny")).toBeDefined();
  expect(changed).not.toHaveBeenCalled();
});

it("offers retry after a failed download", async () => {
  await setup();
  vi.spyOn(commands, "dictationModelInstall").mockResolvedValue({ status: "error", error: { message: "Disk full. Free disk space and retry." } });
  await act(async () => button("Download tiny").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Disk full");
  expect(button("Retry tiny")).toBeDefined();
});

it.each([
  ["vulkan", "AMD Radeon RX 5600 XT"], ["cuda", "NVIDIA RTX"], ["metal", "Apple M2"],
] as const)("shows %s capability separately from requested CPU and actual fallback", async (backend, adapter) => {
  await setup();
  const current = await commands.dictationStatus();
  if (current.status !== "ok") throw new Error("fixture");
  vi.spyOn(commands, "dictationAdvice").mockResolvedValue({ status: "ok", data: { ...current.data, probes: [{ backend, adapter, state: { status: "available" } }], lastExecution: { backend: "cpu", adapter: null, offloaded: false, offloadEvidence: "Fell back to CPU after primary backend failure: driver unavailable" } } });
  await act(async () => button("Refresh resources").click());
  expect(host.textContent).toContain(adapter);
  expect(host.textContent).toContain("execution has not been verified");
  expect(host.textContent).toContain("Requested: small · CPU");
  expect(host.textContent).toContain("Fell back to CPU");
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  [{ status: "omittedFromBuild" }, "Install a build"],
  [{ status: "missingDriverOrRuntime" }, "Update the graphics driver"],
  [{ status: "initializationFailure", details: "device lost" }, "Initialization failed"],
  [{ status: "insufficientMemory", details: { required_bytes: 2048, available_bytes: 0 } }, "select a smaller model"],
  [{ status: "noCompatibleDevice" }, "Connect a supported GPU"],
] as const)("gives an actionable next step for %j", async (state, next) => {
  await setup();
  const current = await commands.dictationStatus();
  if (current.status !== "ok") throw new Error("fixture");
  vi.spyOn(commands, "dictationAdvice").mockResolvedValue({ status: "ok", data: { ...current.data, probes: [{ backend: "vulkan", adapter: null, state }] } });
  await act(async () => button("Refresh resources").click());
  expect(host.textContent).toContain(next);
});

async function withAdvice() {
  await setup();
  const current = await commands.dictationStatus();
  if (current.status !== "ok") throw new Error("fixture");
  const decision = { model: "small", backend: "cpu", adapter: null, adapterId: null, status: "recommended", confidence: "low", provisional: true, safeToLoad: true, reason: "Fits with reserve; check local speed.", medianRtfMilli: null, coldLoadMs: null } as const;
  vi.spyOn(commands, "dictationAdvice").mockResolvedValue({ status: "ok", data: { ...current.data, resourceAdvice: { resources: { capturedAtSecs: 1, cpu: { architecture: "aarch64", model: "Test CPU", usableCores: 8, instructionCompatible: true }, totalRamBytes: 17179869184, availableRamBytes: 8589934592, baselineBytes: 1024, freeDiskBytes: null }, backends: [{ probe: { backend: "cpu", adapter: null, state: { status: "available" } }, adapterId: null, driverVersion: null, runtimeVersion: "test" }], recommendation: { policyVersion: 1, catalogueVersion: 1, preference: "balanced", decisions: [decision], selected: 0 } } } });
  await act(async () => button("Refresh resources").click());
}
it("applies provisional advice only explicitly, preserving enable and language", async () => {
  await withAdvice();
  expect(host.textContent).toContain("Confidence: low");
  expect(changed).not.toHaveBeenCalled();
  await act(async () => button("Apply recommendation").click());
  expect(changed).toHaveBeenCalledWith({ enabled: false, language: "it", device: "cpu", model: "small", backend: null, adapterId: null });
});
it("cancels a performance check, rejects late progress/results and blocks duplicate starts", async () => {
  await withAdvice();
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1, unregisterCallback: vi.fn() } });
  let finish!: (result: { status: "ok"; data: [] }) => void;
  const check = vi.spyOn(commands, "dictationCheckPerformance").mockImplementation((_request, channel) => {
    channel.onmessage({ model: "small", backend: "cpu", adapterId: null, phase: { phase: "measuring", run: 2 } });
    return new Promise(resolve => { finish = resolve; });
  });
  vi.spyOn(commands, "dictationCancelPerformance").mockResolvedValue(undefined);
  const start = button("Check performance");
  await act(async () => { start.click(); start.click(); });
  expect(check).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Measuring run 2 of 3");
  await act(async () => button("Cancel performance check").click());
  await act(async () => finish({ status: "ok", data: [] }));
  expect(host.textContent).toContain("Performance check cancelled");
  expect(host.textContent).not.toContain("Performance check complete");
  expect(changed).not.toHaveBeenCalled();
});
it("reports performance failure and permits a retry without changing settings", async () => {
  await withAdvice();
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1, unregisterCallback: vi.fn() } });
  vi.spyOn(commands, "dictationCheckPerformance").mockResolvedValue({ status: "error", error: { message: "Performance worker timed out. Choose a smaller model." } });
  await act(async () => button("Check performance").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("timed out");
  expect(button("Check performance").disabled).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});
it("cancels an explicit download and waits for it to settle before offering retry", async () => {
  await setup();
  let finish!: (result: { status: "ok"; data: null }) => void;
  vi.spyOn(commands, "dictationModelInstall").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(commands, "dictationModelCancel").mockResolvedValue(undefined);
  vi.spyOn(commands, "dictationModelStatus").mockResolvedValue({ status: "ok", data: { id: "tiny", state: { status: "cancelled" } } });
  vi.spyOn(commands, "dictationAdvice").mockResolvedValue(await commands.dictationStatus());
  await act(async () => button("Download tiny").click());
  await act(async () => button("Cancel tiny download").click());
  expect(button("Retry tiny")).toBeUndefined();
  await act(async () => finish({ status: "ok", data: null }));
  expect(button("Retry tiny")).toBeDefined();
  expect(changed).not.toHaveBeenCalled();
});
it("refreshes advice using the latest preference after a pending download finishes", async () => {
  await withAdvice();
  let finish!: (result: { status: "ok"; data: null }) => void;
  vi.spyOn(commands, "dictationModelInstall").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(commands, "dictationModelStatus").mockResolvedValue({ status: "ok", data: { id: "tiny", state: { status: "installed" } } });
  await act(async () => button("Download tiny").click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Recommendation preference: Balanced"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === "Quality")!.click());
  await act(async () => finish({ status: "ok", data: null }));
  expect(commands.dictationAdvice).toHaveBeenLastCalledWith("quality");
});
