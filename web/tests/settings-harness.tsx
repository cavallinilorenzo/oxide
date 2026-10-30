import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SettingsView } from "../src/SettingsView";
import { GithubSetup } from "../src/GithubSetup";
import { DEFAULT_SHORTCUTS } from "../src/shortcuts";
import { applyAppearance } from "../src/appearance";
import type { UpdateStatus } from "../src/bindings";
import "../src/styles.css";
import "../src/workbench.css";
import "../src/appearance.css";
import "../src/interactions.css";

const installed = new Set<string>();
let updateStatus: UpdateStatus = { currentVersion: "0.1.0", version: null, notes: null, phase: "idle", downloaded: 0, total: null };
mockIPC(async (cmd, args) => {
  if (cmd === "app_update_status") return updateStatus;
  if (cmd === "check_app_update") {
    updateStatus = { ...updateStatus, phase: "available", version: "0.2.0", notes: "Improved Settings and command blocks.\nMore reliable GitHub setup." };
    return updateStatus;
  }
  if (cmd === "install_app_update") {
    updateStatus = { ...updateStatus, phase: "downloading", downloaded: 50, total: 100 };
    const callback = typeof args?.onProgress === "object" ? (args.onProgress as { id: number }).id : Number(String(args?.onProgress).split(":")[1]);
    (window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, message: object) => void } }).__TAURI_INTERNALS__.runCallback(callback, { message: updateStatus, index: 0 });
    await new Promise((r) => setTimeout(r, 500));
    throw { message: "Save your open files before installing the update." };
  }
  if (cmd === "system_fonts") return ["Arial", "Cascadia Code", "Consolas", "Segoe UI", "Times New Roman"];
  if (cmd === "developer_tools") return ["git", "gh"].map((id) => ({ id, name: id === "git" ? "Git" : "GitHub CLI", installed: installed.has(id), path: null, canInstall: true, documentation: "https://cli.github.com/" }));
  if (cmd === "install_developer_tool") { await new Promise((r) => setTimeout(r, 200)); installed.add(String(args?.tool)); return null; }
  if (cmd === "get_settings") return { errors: [], settings: {
    defaultProvider: "claude", confirmQuit: true, shortcuts: DEFAULT_SHORTCUTS,
    claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
    providers: Object.fromEntries(["claude", "codex", "antigravity"].map((p) => [p, { model: null, effort: null, permissionMode: "auto-edit" }])),
  } };
  if (cmd === "detect_provider") return { installed: false, authenticated: false, available: false };
  if (cmd === "get_model_catalog") return [];
  if (cmd === "plugin:event|listen") return 1;
  return null;
});
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
applyAppearance();
createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh", display: "flex", overflow: "auto" }}>{location.search.includes("setup") ? <GithubSetup guidance="Install the missing tools to continue." onReady={() => {}} /> : <SettingsView onClose={() => {}} />}</div>);
