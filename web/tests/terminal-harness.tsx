// Browser-only IPC adapter: all shell commands/output/resize events use the real Rust PTY.
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { TerminalWorkbench } from "../src/TerminalWorkbench";
import "../src/styles.css";
import "../src/workbench.css";
import "../src/appearance.css";
import { applyAppearance } from "../src/appearance";
import { AppearanceSettings } from "../src/AppearanceSettings";
import { WorkbenchLoading } from "../src/WorkbenchLoading";
applyAppearance();
declare global {
  interface Window {
    nativeTerminal: (cmd: string, args: object) => Promise<unknown>;
    nativeOutput: (bytes: number[]) => void;
    terminalRoot: string;
  }
}
let callback: number;
let index = 0;
mockIPC(async (cmd, args) => {
  if (cmd === "start_block_terminal") {
    callback =
      typeof args!.onOutput === "object"
        ? (args!.onOutput as { id: number }).id
        : Number(String(args!.onOutput).split(":")[1]);
  }
  return await window.nativeTerminal(cmd, args!);
});
window.nativeOutput = (bytes) => {
  (
    window as unknown as {
      __TAURI_INTERNALS__: {
        runCallback: (id: number, value: unknown) => void;
      };
    }
  ).__TAURI_INTERNALS__.runCallback(callback, {
    message: bytes,
    index: index++,
  });
};
createRoot(document.getElementById("root")!).render(
  <div style={{ height: "100vh", display: "flex" }}>
    {location.search.includes("appearance") && (
      <aside
        className="settings"
        style={{ width: 700, flex: "none", overflow: "auto" }}
      >
        <AppearanceSettings />
      </aside>
    )}
    {location.search.includes("loading") ? (
      <WorkbenchLoading mode="code" />
    ) : (
      <TerminalWorkbench
        projectId={1}
        threadId={null}
        rootPath={window.terminalRoot}
        contextKey="native-repro"
        visible
        queuedCommand={null}
        onCommandConsumed={() => {}}
      />
    )}
  </div>,
);
