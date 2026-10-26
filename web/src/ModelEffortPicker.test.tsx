// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ModelEffortPicker } from "./ModelEffortPicker";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); });

it("shows only the selected Codex model's reasoning levels", async () => {
  const catalog = [
    { id: "gpt-6.1-terra", name: "Terra", description: null, supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", isLegacy: false },
    { id: "gpt-6-luna", name: "Luna", description: null, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium", isLegacy: false },
  ];
  mockIPC((command, args) => {
    if (command === "get_favourite_models") return [];
    if (command === "get_model_catalog") return (args as { provider: string }).provider === "codex" ? catalog : [];
    throw new Error(`Unexpected command ${command}`);
  });
  const render = (model: string) => root.render(<ModelEffortPicker open onClose={() => {}}
    currentProvider="codex" currentModel={model} currentEffort="medium" turnCount={0}
    midThreadModelSwitch onSelectModelAndEffort={() => {}} initialMode="effort" />);
  await act(async () => render("gpt-6-luna"));
  expect(Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent)).toEqual(["Low", "Medium", "High", "Xhigh", "Max"]);
  await act(async () => render("gpt-6.1-terra"));
  expect(Array.from(container.querySelectorAll('[role="option"]')).map((el) => el.textContent)).toEqual(["Low", "Medium", "High", "Xhigh", "Max", "Ultra"]);
});

it("returns to Favourites when the model picker is reopened", async () => {
  mockIPC((command) => {
    if (command === "get_favourite_models" || command === "get_model_catalog") return [];
    throw new Error(`Unexpected command ${command}`);
  });
  const picker = <ModelEffortPicker open onClose={() => {}} currentProvider="codex"
    currentModel={null} currentEffort={null} turnCount={0} midThreadModelSwitch
    onSelectModelAndEffort={() => {}} />;
  await act(async () => root.render(picker));
  const favourites = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Favourites"))!;
  await act(async () => favourites.click());
  await act(async () => root.render(null));
  await act(async () => root.render(picker));
  expect(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Favourites"))?.classList.contains("active")).toBe(true);
});
