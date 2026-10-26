import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./bindings";
import { displayPath, middleEllipsis, threadHeaderLines } from "./headerLines";

const model = (id: string, name: string): ModelInfo => ({
  id,
  name,
  description: null,
  supportedEfforts: [],
  defaultEffort: null,
  isLegacy: false,
});

const catalog = [model("claude-opus-5-5", "Opus 5.5"), model("claude-sonnet-5-5", "Sonnet 5.5")];

const base = {
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  thread: null,
  projectPath: "/Users/lorenzo/Developer/project/oxide",
  catalog,
};

describe("displayPath", () => {
  it("shortens the home directory to ~", () => {
    expect(displayPath("/Users/lorenzo/Developer/oxide")).toBe("~/Developer/oxide");
    expect(displayPath("/home/lorenzo/code")).toBe("~/code");
    expect(displayPath("/opt/work")).toBe("/opt/work");
  });
});

it("shows Windows canonical paths without the extended-length prefix", () => {
  const lines = threadHeaderLines({ ...base, projectPath: String.raw`\\?\C:\Users\mbena\Documents\spotify_analysis` });
  expect(lines.folder.text).toBe(String.raw`C:\Users\mbena\Documents\spotify_analysis`);
  expect(lines.folder.path).toBe(String.raw`C:\Users\mbena\Documents\spotify_analysis`);
  expect(displayPath(String.raw`\\?\UNC\server\share\repo`)).toBe(String.raw`\\server\share\repo`);
});

describe("middleEllipsis", () => {
  it("leaves a short path alone", () => {
    expect(middleEllipsis("~/Developer/oxide", 40)).toBe("~/Developer/oxide");
  });

  it("cuts a long path in the middle, keeping both ends", () => {
    const cut = middleEllipsis("~/Developer/project/oxide/.claude/worktrees/feat+147-thread-header-banner", 40);
    expect(cut).toHaveLength(40);
    expect(cut.startsWith("~/Developer/")).toBe(true);
    expect(cut.endsWith("thread-header-banner")).toBe(true);
    expect(cut).toContain("…");
  });
});

describe("threadHeaderLines", () => {
  it("names the Model readably and appends the Effort", () => {
    expect(threadHeaderLines(base).modelLine).toBe("Opus 5.5 · high");
  });

  it("falls back to the raw Model id when the catalog does not know it", () => {
    expect(threadHeaderLines({ ...base, model: "claude-future-9" }).modelLine).toBe("claude-future-9 · high");
    expect(threadHeaderLines({ ...base, catalog: null }).modelLine).toBe("claude-opus-5-5 · high");
  });

  it("leaves the Effort out when there is none", () => {
    expect(threadHeaderLines({ ...base, effort: null }).modelLine).toBe("Opus 5.5");
  });

  it("names the Provider when no Model is picked yet", () => {
    expect(threadHeaderLines({ ...base, model: null, effort: null }).modelLine).toBe("Claude Code");
    expect(threadHeaderLines({ ...base, provider: "codex", model: null, effort: null }).modelLine).toBe("Codex");
    expect(threadHeaderLines({ ...base, provider: "antigravity", model: null, effort: null }).modelLine).toBe(
      "Antigravity",
    );
  });

  it("finds an Antigravity Model through its effort-less family", () => {
    const lines = threadHeaderLines({
      ...base,
      provider: "antigravity",
      model: "gemini-pro-high",
      effort: "high",
      catalog: [model("gemini-pro-high", "Gemini Pro (high)")],
    });
    expect(lines.modelLine).toBe("Gemini Pro · high");
  });

  it("drops an effort the name carries in parentheses, as the Effort follows it", () => {
    const lines = threadHeaderLines({
      ...base,
      provider: "antigravity",
      model: "gemini-3-8-flash-high",
      effort: "high",
      catalog: [model("gemini-3-8-flash-high", "Gemini 3.8 Flash (High)")],
    });
    expect(lines.modelLine).toBe("Gemini 3.8 Flash · high");
  });

  it("keeps other parentheses in a Model name", () => {
    const lines = threadHeaderLines({
      ...base,
      model: "claude-sonnet-4-6",
      effort: null,
      catalog: [model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)")],
    });
    expect(lines.modelLine).toBe("Claude Sonnet 4.6 (Thinking)");
  });

  it("shows the Project path for an ordinary Thread", () => {
    expect(threadHeaderLines(base).folder).toEqual({
      path: "/Users/lorenzo/Developer/project/oxide",
      text: "~/Developer/project/oxide",
      branch: null,
    });
  });

  it("shows the worktree path and branch for a Board Thread", () => {
    const lines = threadHeaderLines({
      ...base,
      thread: { worktreePath: "/Users/lorenzo/.oxide/worktrees/oxide-7", branch: "oxide/7-fix" },
    });
    expect(lines.folder).toEqual({
      path: "/Users/lorenzo/.oxide/worktrees/oxide-7",
      text: "~/.oxide/worktrees/oxide-7",
      branch: "oxide/7-fix",
    });
  });
});
