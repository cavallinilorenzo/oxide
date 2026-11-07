// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Settings_Deserialize as Settings } from "./bindings";
import { SettingsView } from "./SettingsView";
import { DEFAULT_SHORTCUTS } from "./shortcuts";
import { getAppearance } from "./appearance";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  clearMocks();
  window.history.replaceState(null, "", window.location.pathname);
});

const categoryButton = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings categories"] button'))
    .find((button) => button.textContent === label)!;
const categoryPanel = (id: string) =>
  container.querySelector<HTMLElement>(`[data-settings-category="${id}"]`)!;
const activePanels = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-settings-category]"))
    .filter((panel) => !panel.hidden)
    .map((panel) => panel.dataset.settingsCategory);

function mockSettings(settings: Settings, onSave?: (saved: Settings) => void) {
  Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
  mockIPC((command, args) => {
    if (command === "get_settings") return { settings, errors: [] };
    if (command === "save_settings") {
      const saved = (args as { settings: Settings }).settings;
      onSave?.(saved);
      return null;
    }
    if (command === "get_model_catalog") return [];
    if (command === "detect_provider") return { installed: false, authenticated: false, available: false };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten" || command === "dictation_cancel") return null;
    throw new Error(`Unexpected command ${command}`);
  });
}

const baseSettings = (): Settings => ({
  dictation: { enabled: false, language: "auto", device: "cpu", model: "small" },
  defaultProvider: "claude", confirmQuit: true, shortcuts: DEFAULT_SHORTCUTS,
  claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
  providers: {
    claude: { model: null, effort: null, permissionMode: "ask" },
    codex: { model: null, effort: null, permissionMode: "auto-edit" },
    antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
  },
});

it("switches between categorized panels and saves appearance, dictation and each Provider independently", async () => {
  let saved: Settings | undefined;
  let pendingSave: Promise<null> | null = null;
  // Let the save lifecycle test hold the request open.
  mockIPC((command, args) => {
    if (command === "get_settings") return { settings: baseSettings(), errors: [] };
    if (command === "save_settings") {
      saved = (args as { settings: Settings }).settings;
      return pendingSave;
    }
    if (command === "get_model_catalog") return [];
    if (command === "detect_provider") return { installed: false, authenticated: false, available: false };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten" || command === "dictation_cancel") return null;
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<SettingsView onRunCommand={() => {}} onClose={() => {}} />));

  expect(Array.from(container.querySelectorAll('nav[aria-label="Settings categories"] button')).map((button) => button.textContent)).toEqual([
    "General", "Providers", "Appearance", "Voice & Dictation", "Developer Tools", "Shortcuts", "Updates",
  ]);
  expect(activePanels()).toEqual(["general"]);
  expect(categoryButton("General").getAttribute("aria-current")).toBe("page");
  expect(categoryPanel("general").querySelector('[aria-label^="Default Provider:"]')).not.toBeNull();

  act(() => categoryButton("Providers").click());
  expect(activePanels()).toEqual(["providers"]);
  expect(categoryButton("Providers").getAttribute("aria-current")).toBe("page");
  expect(window.location.hash).toBe("#settings-providers");

  const modeButton = (provider: string) => categoryPanel("providers").querySelector<HTMLButtonElement>(`button[aria-label^="${provider} Permission mode:"]`)!;
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
    expect(categoryPanel("providers").querySelector(`[aria-label="${provider} Full access warning"]`)?.textContent).toContain("modify or delete files and run commands without asking");
  }

  act(() => categoryButton("Appearance").click());
  expect(activePanels()).toEqual(["appearance"]);
  const terminalSize = categoryPanel("appearance").querySelector<HTMLSelectElement>('select[aria-label="Terminal size"]')!;
  await act(async () => { terminalSize.value = "18"; terminalSize.dispatchEvent(new Event("change", { bubbles: true })); });

  act(() => categoryButton("Voice & Dictation").click());
  expect(activePanels()).toEqual(["dictation"]);
  // Language tools live here, no longer behind a gear in the Files editor.
  const dictation = categoryPanel("dictation").querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => dictation.click());

  act(() => categoryButton("Developer Tools").click());
  expect(activePanels()).toEqual(["developer"]);
  expect(categoryPanel("developer").querySelector("#settings-github")).not.toBeNull();
  expect(categoryPanel("developer").querySelector("#settings-language")).not.toBeNull();
  expect(container.textContent).not.toContain("Open in editor");

  act(() => categoryButton("Shortcuts").click());
  expect(activePanels()).toEqual(["shortcuts"]);
  expect(categoryPanel("shortcuts").querySelector("#settings-shortcuts")).not.toBeNull();

  act(() => categoryButton("Updates").click());
  expect(activePanels()).toEqual(["updates"]);
  expect(categoryPanel("updates").querySelector("#settings-updates")).not.toBeNull();

  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save")!.click());
  expect(getAppearance().typography?.terminal.size).toBe(18);
  expect(saved?.dictation).toEqual({ enabled: true, language: "auto", device: "cpu", model: "small" });
  expect(container.querySelector('[aria-label="Settings save status"]')?.textContent).toBe("Settings saved.");
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
  act(() => categoryPanel("dictation").querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(saveButton.disabled).toBe(true);
  await act(async () => completeSave(null));
  expect(container.querySelector('[aria-label="Settings save status"]')?.textContent).toBe("");
  expect(saveButton.disabled).toBe(false);
});

it("opens the matching category for a deep-linked section", async () => {
  mockSettings(baseSettings());
  await act(async () => root.render(<SettingsView onRunCommand={() => {}} onClose={() => {}} section="language" />));
  expect(activePanels()).toEqual(["developer"]);
  expect(categoryButton("Developer Tools").getAttribute("aria-current")).toBe("page");
  expect(categoryPanel("developer").querySelector("#settings-language")).not.toBeNull();

  await act(async () => root.render(<SettingsView onRunCommand={() => {}} onClose={() => {}} section="appearance" />));
  expect(activePanels()).toEqual(["appearance"]);
  expect(categoryButton("Appearance").getAttribute("aria-current")).toBe("page");
});

it("restores the active category from the URL hash", async () => {
  mockSettings(baseSettings());
  window.history.replaceState(null, "", "#settings-shortcuts");
  await act(async () => root.render(<SettingsView onRunCommand={() => {}} onClose={() => {}} />));
  expect(activePanels()).toEqual(["shortcuts"]);
  expect(categoryButton("Shortcuts").getAttribute("aria-current")).toBe("page");
});

it("groups model effort variants while keeping the saved effort selectable", async () => {
  const settings: Settings = {
    ...baseSettings(),
    defaultProvider: "antigravity",
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
    if (command === "detect_provider") return { installed: false, authenticated: false, available: false };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten" || command === "dictation_cancel") return null;
    throw new Error(`Unexpected command ${command}`);
  });
  await act(async () => root.render(<SettingsView onRunCommand={() => {}} onClose={() => {}} />));
  act(() => categoryButton("Providers").click());
  const model = categoryPanel("providers").querySelector<HTMLButtonElement>('button[aria-label="Antigravity CLI Model: Gemini Pro"]')!;
  expect(model).toBeTruthy();
  act(() => model.click());
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent)).toEqual(["Provider default", "Gemini Pro"]);
  act(() => (document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement).click());
  const effort = categoryPanel("providers").querySelector<HTMLButtonElement>('button[aria-label="Antigravity CLI Effort: low"]')!;
  act(() => effort.click());
  const high = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === "high")!;
  act(() => high.click());
  await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Save")!.click());
  expect(saved?.providers.antigravity.effort).toBe("high");
});
