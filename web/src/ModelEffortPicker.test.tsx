// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { resetCatalogCache } from "./modelCatalogCache";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); resetCatalogCache(); });

it("restores Favourites and skips uninstalled Providers with both mouse and keyboard", async () => {
  const chosen = vi.fn();
  const model = { id: "gpt", name: "GPT", description: null, supportedEfforts: ["low", "high"], defaultEffort: "low", isLegacy: false };
  mockIPC((command, args) => {
    if (command === "detect_provider") return { installed: (args as { provider: string }).provider !== "claude" };
    if (command === "get_favourite_models") return ["gpt"];
    if (command === "get_model_catalog") return (args as { provider: string }).provider === "codex" ? [model] : [];
    return null;
  });
  await act(async () => root.render(<ModelEffortPicker open onClose={() => {}} currentProvider="codex" currentModel="gpt" currentEffort="high" turnCount={0} midThreadModelSwitch onSelectModelAndEffort={chosen} />));
  const tab = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>(".provider-tab")).find((b) => b.textContent === name)!;
  expect(tab("Claude").disabled).toBe(true);
  await act(async () => tab("Claude").click());
  expect(tab("Codex").classList.contains("active")).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
  expect(tab("Favourites").classList.contains("active")).toBe(true);
  expect(container.querySelector('.models-listbox')?.textContent).toContain("GPT");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(chosen).toHaveBeenCalledWith("codex", "gpt", "high");
});

it("shows the highlighted Codex model's reasoning levels on the Effort slider", async () => {
  const catalog = [
    { id: "gpt-6.1-terra", name: "Terra", description: null, supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", isLegacy: false },
    { id: "gpt-6-luna", name: "Luna", description: null, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", isLegacy: false },
  ];
  mockIPC((command, args) => {
    if (command === "detect_provider") return { installed: true, available: true, authenticated: true, version: "1", warning: null };
    if (command === "get_favourite_models") return [];
    if (command === "get_model_catalog") return (args as { provider: string }).provider === "codex" ? catalog : [];
    throw new Error(`Unexpected command ${command}`);
  });
  const render = (model: string) => root.render(<ModelEffortPicker open onClose={() => {}}
    currentProvider="codex" currentModel={model} currentEffort="medium" turnCount={0}
    midThreadModelSwitch onSelectModelAndEffort={() => {}} />);
  await act(async () => render("gpt-6-luna"));
  const stops = () => Array.from(container.querySelectorAll(".effort-stop")).map((el) => el.textContent);
  expect(stops()).toEqual(["low", "medium", "high", "xhigh", "max"]);
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
  expect(stops()).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
});

it("returns to the last Provider tab when the model picker is reopened", async () => {
  mockIPC((command) => {
    if (command === "detect_provider") return { installed: true, available: true, authenticated: true, version: "1", warning: null };
    if (command === "get_favourite_models" || command === "get_model_catalog") return [];
    throw new Error(`Unexpected command ${command}`);
  });
  const picker = <ModelEffortPicker open onClose={() => {}} currentProvider="codex"
    currentModel={null} currentEffort={null} turnCount={0} midThreadModelSwitch
    onSelectModelAndEffort={() => {}} />;
  const tab = (name: string) => Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes(name))!;
  await act(async () => root.render(picker));
  await act(async () => tab("Antigravity").click());
  await act(async () => root.render(null));
  await act(async () => root.render(picker));
  expect(tab("Antigravity").classList.contains("active")).toBe(true);
});

it("tints and decorates the Effort panel more as the level rises", async () => {
  const catalog = [{ id: "m", name: "M", description: null, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", isLegacy: false }];
  mockIPC((command, args) => {
    if (command === "detect_provider") return { installed: true, available: true, authenticated: true, version: "1", warning: null };
    if (command === "get_favourite_models") return [];
    if (command === "get_model_catalog") return (args as { provider: string }).provider === "codex" ? catalog : [];
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<ModelEffortPicker open onClose={() => {}}
    currentProvider="codex" currentModel="m" currentEffort="low" turnCount={0}
    midThreadModelSwitch onSelectModelAndEffort={() => {}} />));
  await act(async () => {});
  const panel = () => container.querySelector(".effort-panel") as HTMLElement;
  const step = () => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  const seen: string[] = [];
  const sparkles: number[] = [];
  for (let i = 0; i < 5; i++) {
    seen.push(`${panel().dataset.tier}:${panel().style.getPropertyValue("--effort")}`);
    sparkles.push(container.querySelectorAll(".effort-sparkles i").length);
    await step();
  }
  expect(seen.map((s) => s.split(":")[0])).toEqual(["0", "1", "2", "3", "4"]);
  expect(new Set(seen.map((s) => s.split(":")[1])).size).toBe(5);
  expect(sparkles[0]).toBe(0);
  expect(sparkles[4]).toBeGreaterThan(sparkles[3]!);
});
