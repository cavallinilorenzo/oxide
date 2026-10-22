import type { Detection } from "./bindings";

export interface ProviderHint {
  type: "missing" | "unauthenticated" | "warning" | "ok";
  message: string;
  command?: string;
}

export function getClaudeCodeHint(detection: Detection | null): ProviderHint | null {
  if (!detection) return null;
  if (!detection.installed) {
    return {
      type: "missing",
      message: "Claude Code is not installed on your machine.",
      command: "npm install -g @anthropic-ai/claude-code",
    };
  }
  if (!detection.authenticated) {
    return {
      type: "unauthenticated",
      message: "Claude Code is installed but not logged in.",
      command: "claude login",
    };
  }
  if (detection.warning) {
    return {
      type: "warning",
      message: detection.warning,
    };
  }
  return {
    type: "ok",
    message: `Claude Code ${detection.version ?? ""} ready.`,
  };
}

export const CLAUDE_30_DAY_RETENTION_WARNING =
  "Claude Code automatically purges sessions after 30 days by default. Oxide retains complete transcripts permanently, but resuming conversations after 30 days will require starting a new Thread. You can adjust session retention in your Claude Code settings (e.g. via cleanupPeriodDays or CLAUDE_AUTO_CLEAN_SESSIONS).";
