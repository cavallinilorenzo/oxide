import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SettingsView } from "../src/SettingsView";
import { GithubSetup } from "../src/GithubSetup";
import { DEFAULT_SHORTCUTS } from "../src/shortcuts";
import { applyAppearance } from "../src/appearance";
import "../src/styles.css";
import "../src/workbench.css";
import "../src/appearance.css";
import "../src/interactions.css";

const installed = new Set<string>();
mockIPC(async (cmd, args) => {
  if (cmd === "system_fonts") return ["Arial", "Cascadia Code", "Consolas", "Segoe UI", "Times New Roman"];
  if (cmd === "developer_tools") return ["git", "gh"].map((id) => ({ id, name: id === "git" ? "Git" : "GitHub CLI", installed: installed.has(id), path: null, canInstall: true, documentation: "https://cli.github.com/" }));
  if (cmd === "install_developer_tool") { await new Promise((r) => setTimeout(r, 200)); installed.add(String(args?.tool)); return null; }
  if (cmd === "get_settings") return { errors: [], settings: {
    defaultProvider: "claude", confirmQuit: true, editor: "", shortcuts: DEFAULT_SHORTCUTS,
    claudeCustomizations: { claudeMd: false, skills: false, plugins: false, mcpServers: false, hooks: false },
    providers: Object.fromEntries(["claude", "codex", "antigravity"].map((p) => [p, { model: null, effort: null, permissionMode: "auto-edit" }])),
  } };
  if (cmd === "detect_provider") return { installed: false, authenticated: false, available: false };
  if (cmd === "detected_editors" || cmd === "get_model_catalog") return [];
  if (cmd === "plugin:event|listen") return 1;
  return null;
});
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });
applyAppearance();
createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh", display: "flex", overflow: "auto" }}>{location.search.includes("setup") ? <GithubSetup guidance="Install the missing tools to continue." onReady={() => {}} /> : <SettingsView onClose={() => {}} />}</div>);
