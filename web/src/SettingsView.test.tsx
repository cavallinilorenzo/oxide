// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Settings_Deserialize as Settings } from "./bindings";
import { SettingsView } from "./SettingsView";
import { DEFAULT_SHORTCUTS } from "./shortcuts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); });

it("offers supported defaults with descriptions, warns about Full access and saves each Provider independently", async () => {
  const settings: Settings = {
    dictation: { enabled: false, language: "auto", device: "cpu" },
    defaultProvider: "claude", confirmQuit: true, editor: "", shortcuts: DEFAULT_SHORTCUTS, claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
    providers: {
      claude: { model: null, effort: null, permissionMode: "ask" },
      codex: { model: null, effort: null, permissionMode: "auto-edit" },
      antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
    },
  };
  let saved: Settings | undefined;
  let pendingSave: Promise<null> | null = null;
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  mockIPC((command, args) => {
    if (command === "get_settings") return { settings, errors: [] };
    if (command === "save_settings") { saved = (args as { settings: Settings }).settings; return pendingSave; }
    if (command === "detected_editors" || command === "get_model_catalog") return [];
    if (command === "detect_provider") return { installed: false, authenticated: false, available: false };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return null;
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<SettingsView onClose={() => {}} />));
  const modeButton = (provider: string) => container.querySelector<HTMLButtonElement>(`button[aria-label^="${provider} Permission mode:"]`)!;
  for (const provider of ["Claude Code", "Codex", "Antigravity CLI"]) {
    act(() => modeButton(provider).click());
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options.map((option) => option.textContent)).toEqual(provider === "Antigravity CLI" ? [
      "Auto-edit (soft-deny)Edits files in the Thread’s folder; other actions are denied.",
      "Full accessAllows all actions without asking for approval.",
    ] : [
      "AskAsks before file edits and commands.",
      "Auto-editEdits files in the Thread’s folder; asks before other actions.",
      "Full accessAllows all actions without asking for approval.",
    ]);
    act(() => options[options.length - 1].click());
    expect(container.querySelector(`[aria-label="${provider} Full access warning"]`)?.textContent).toContain("modify or delete files and run commands without asking");
  }
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save")!.click());
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Settings saved.");
  expect(saved?.providers).toEqual({
    claude: { model: null, effort: null, permissionMode: "full-access" },
    codex: { model: null, effort: null, permissionMode: "full-access" },
    antigravity: { model: null, effort: null, permissionMode: "full-access" },
  });
  // A change made while saving must not be reported as saved by that request.
  let completeSave: (result: null) => void = () => {};
  pendingSave = new Promise((resolve) => { completeSave = resolve; });
  const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save")!;
  await act(async () => saveButton.click());
  expect(saveButton.disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(saveButton.disabled).toBe(true);
  await act(async () => completeSave(null));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  expect(saveButton.disabled).toBe(false);
});


it("groups model effort variants while keeping the saved effort selectable", async () => {
  const settings: Settings = {
    dictation: { enabled: false, language: "auto", device: "cpu" },
    defaultProvider: "antigravity", confirmQuit: true, editor: "", shortcuts: DEFAULT_SHORTCUTS,
    claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
    providers: {
      claude: { model: null, effort: null, permissionMode: "ask" },
      codex: { model: null, effort: null, permissionMode: "auto-edit" },
      antigravity: { model: "gemini-pro-low", effort: "low", permissionMode: "auto-edit" },
    },
  };
  const variants = ["low", "high"].map((effort) => ({
    id: `gemini-pro-${effort}`, name: `Gemini Pro (${effort})`, description: null,
    supportedEfforts: [effort], defaultEffort: effort, isLegacy: false,
  }));
  let saved: Settings | undefined;
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  mockIPC((command, args) => {
    if (command === "get_settings") return { settings, errors: [] };
    if (command === "save_settings") { saved = (args as { settings: Settings }).settings; return null; }
    if (command === "get_model_catalog") return (args as { provider: string }).provider === "antigravity" ? variants : [];
    if (command === "detected_editors") return [];
    if (command === "detect_provider") return { installed: false, authenticated: false, available: false };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return null;
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<SettingsView onClose={() => {}} />));
  const model = container.querySelector<HTMLButtonElement>('button[aria-label="Antigravity CLI Model: Gemini Pro"]')!;
  expect(model).toBeTruthy();
  act(() => model.click());
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toEqual(["Provider default", "Gemini Pro"]);
  act(() => (document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement).click());
  const effort = container.querySelector<HTMLButtonElement>('button[aria-label="Antigravity CLI Effort: low"]')!;
  act(() => effort.click());
  const high = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === "high")!;
  act(() => high.click());
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save")!.click());
  expect(saved?.providers.antigravity.effort).toBe("high");
});
