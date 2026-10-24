import { describe, expect, it } from "vitest";
import {
  getClaudeCodeHint,
  CLAUDE_30_DAY_RETENTION_WARNING,
} from "./providerHints";

describe("providerHints", () => {
  it("provides install hint when Claude Code is not installed", () => {
    const hint = getClaudeCodeHint({
      available: false,
      installed: false,
      version: null,
      authenticated: false,
      warning: null,
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("missing");
    expect(hint?.command).toBe("npm install -g @anthropic-ai/claude-code");
  });

  it("provides login hint when Claude Code is installed but not authenticated", () => {
    const hint = getClaudeCodeHint({
      available: false,
      installed: true,
      version: "1.0.0",
      authenticated: false,
      warning: null,
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("unauthenticated");
    expect(hint?.command).toBe("claude login");
  });

  it("provides warning when Claude Code is out of pinned version range", () => {
    const hint = getClaudeCodeHint({
      available: true,
      installed: true,
      version: "3.0.0",
      authenticated: true,
      warning: "Claude Code version 3.0.0 is outside the pinned range tested with Oxide (>= 0.2.0, < 3.0.0)",
    });
    expect(hint).not.toBeNull();
    expect(hint?.type).toBe("warning");
    expect(hint?.message).toContain("outside the pinned range");
  });

  it("exposes the 30-day session retention warning", () => {
    expect(CLAUDE_30_DAY_RETENTION_WARNING).toContain("30 days");
    expect(CLAUDE_30_DAY_RETENTION_WARNING).toContain("retention");
  });
});
