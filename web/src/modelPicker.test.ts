import { describe, expect, it } from "vitest";
import {
  applyModelShortcut,
  selectedModelInfo,
  resolveDefaultModel,
  filterModels,
  parseSlashCommand,
  resolveModelQuery,
  modelNameSuggestions,
  type ModelInfo,
} from "./modelPicker";

const sampleModels: ModelInfo[] = [
  {
    id: "claude-3-7-sonnet",
    name: "Claude 3.7 Sonnet",
    description: "Hybrid reasoning model",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isLegacy: false,
  },
  {
    id: "claude-3-5-haiku",
    name: "Claude 3.5 Haiku",
    description: "Fast model",
    supportedEfforts: [],
    defaultEffort: null,
    isLegacy: false,
  },
  {
    id: "claude-3-opus",
    name: "Claude 3 Opus",
    description: "Legacy intelligence",
    supportedEfforts: [],
    defaultEffort: null,
    isLegacy: true,
  },
  {
    id: "gpt-5",
    name: "GPT-5",
    description: "Flagship",
    supportedEfforts: ["low", "medium", "high"],
    defaultEffort: "high",
    isLegacy: false,
  },
];

describe("parseSlashCommand", () => {
  it("recognizes Oxide's remaining commands and preserves multiword names", () => {
    expect(parseSlashCommand("/rename  A new title ")).toEqual({ type: "rename", command: "/rename", arg: "A new title" });
    expect(parseSlashCommand("/diff")).toEqual({ type: "diff", command: "/diff", arg: undefined });
    expect(parseSlashCommand("/permissions ask")).toEqual({ type: "permissions", command: "/permissions", arg: "ask" });
  });
  it("detects /model command with and without argument", () => {
    expect(parseSlashCommand("/model")).toEqual({
      type: "model",
      command: "/model",
      arg: undefined,
    });
    expect(parseSlashCommand("/model claude-3-7-sonnet")).toEqual({
      type: "model",
      command: "/model",
      arg: "claude-3-7-sonnet",
    });
    expect(parseSlashCommand("   /model    gpt-5   ")).toEqual({
      type: "model",
      command: "/model",
      arg: "gpt-5",
    });
  });

  it("detects /effort command with and without argument", () => {
    expect(parseSlashCommand("/effort")).toEqual({
      type: "effort",
      command: "/effort",
      arg: undefined,
    });
    expect(parseSlashCommand("/effort high")).toEqual({
      type: "effort",
      command: "/effort",
      arg: "high",
    });
  });

  it("identifies other slash commands and regular text", () => {
    expect(parseSlashCommand("/custom-cmd hello")).toEqual({
      type: "other",
      command: "/custom-cmd",
      arg: "hello",
    });
    expect(parseSlashCommand("hello /model world")).toEqual({
      type: "none",
      command: "",
      arg: undefined,
    });
  });
});

describe("filterModels", () => {
  it("splits active and legacy models", () => {
    const { current, legacy } = filterModels(sampleModels, "");
    expect(current.map((m) => m.id)).toEqual([
      "claude-3-7-sonnet",
      "claude-3-5-haiku",
      "gpt-5",
    ]);
    expect(legacy.map((m) => m.id)).toEqual(["claude-3-opus"]);
  });

  it("filters by name, id or description", () => {
    const { current: byName } = filterModels(sampleModels, "haiku");
    expect(byName.map((m) => m.id)).toEqual(["claude-3-5-haiku"]);

    const { current: byDesc } = filterModels(sampleModels, "hybrid");
    expect(byDesc.map((m) => m.id)).toEqual(["claude-3-7-sonnet"]);

    const { legacy: byLegacy } = filterModels(sampleModels, "opus");
    expect(byLegacy.map((m) => m.id)).toEqual(["claude-3-opus"]);
  });
});

describe("applyModelShortcut", () => {
  it("picks 1-indexed model within range", () => {
    expect(applyModelShortcut(1, sampleModels)?.id).toBe("claude-3-7-sonnet");
    expect(applyModelShortcut(3, sampleModels)?.id).toBe("claude-3-opus");
    expect(applyModelShortcut(5, sampleModels)).toBeNull();
    expect(applyModelShortcut(0, sampleModels)).toBeNull();
  });
});

describe("selectedModelInfo", () => {
  it("returns only the selected model's supported efforts", () => {
    const models = [
      { ...sampleModels[3]!, id: "full", supportedEfforts: ["low", "high", "max", "ultra"] },
      { ...sampleModels[3]!, id: "limited", supportedEfforts: ["low", "high"] },
    ];
    expect(selectedModelInfo(models, "limited")?.supportedEfforts).toEqual(["low", "high"]);
    expect(selectedModelInfo(models, "unknown")).toBeUndefined();
    expect(selectedModelInfo(models, null)).toBeUndefined();
  });
});

describe("resolveDefaultModel", () => {
  const catalog: ModelInfo[] = [
    { id: "old", name: "Old", description: null, supportedEfforts: ["low"], defaultEffort: "low", isLegacy: true },
    { id: "new", name: "New", description: null, supportedEfforts: ["low", "high"], defaultEffort: "high", isLegacy: false },
  ];

  it("names the first current Model and its default Effort when none is picked", () => {
    expect(resolveDefaultModel(catalog, null, null)).toEqual({ model: "new", effort: "high" });
  });

  it("keeps a picked Model and Effort", () => {
    expect(resolveDefaultModel(catalog, "old", "low")).toEqual({ model: "old", effort: "low" });
  });

  it("fills only the Effort when the Model is picked", () => {
    expect(resolveDefaultModel(catalog, "new", null)).toEqual({ model: "new", effort: "high" });
  });

  it("leaves things as they are while the catalog is unknown", () => {
    expect(resolveDefaultModel(null, null, null)).toEqual({ model: null, effort: null });
  });
});

describe("resolveModelQuery", () => {
  const flash: ModelInfo = {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast",
    supportedEfforts: [],
    defaultEffort: null,
    isLegacy: false,
  };
  const split: ModelInfo[] = [
    { ...sampleModels[0]!, id: "claude-sonnet-low", name: "Claude Sonnet (Low)" },
    { ...sampleModels[0]!, id: "claude-sonnet-high", name: "Claude Sonnet (High)" },
  ];

  it("matches an exact id case-insensitively", () => {
    expect(resolveModelQuery(sampleModels, "CLAUDE-3-7-SONNET", null).model?.id).toBe("claude-3-7-sonnet");
  });

  it("matches a name regardless of case and punctuation", () => {
    expect(resolveModelQuery(sampleModels, "claude 3.5 haiku", null).model?.id).toBe("claude-3-5-haiku");
  });

  it("collapses effort-suffixed variants into one family and picks the matching Effort", () => {
    const resolution = resolveModelQuery(split, "sonnet", "high");
    expect(resolution.model?.id).toBe("claude-sonnet-high");
    expect(resolution.matches).toHaveLength(1);
    expect(resolveModelQuery(split, "claude-sonnet-low", null).model?.name).toBe("Claude Sonnet");
  });

  it("matches generous substrings such as flash, sonnet and gpt", () => {
    expect(resolveModelQuery([...sampleModels, flash], "flash", null).model?.id).toBe("gemini-2.5-flash");
    expect(resolveModelQuery(sampleModels, "sonnet", null).model?.id).toBe("claude-3-7-sonnet");
    expect(resolveModelQuery(sampleModels, "gpt", null).model?.id).toBe("gpt-5");
    expect(resolveModelQuery([...sampleModels, flash], "gpt5", null).model?.id).toBe("gpt-5");
  });

  it("prefers a current Model over a legacy one when several match", () => {
    const resolution = resolveModelQuery(sampleModels, "claude", null);
    expect(resolution.matches.length).toBeGreaterThan(1);
    expect(resolution.matches[0]!.isLegacy).toBe(false);
    expect(resolution.model?.isLegacy).toBe(false);
  });

  it("picks the closest match among equally ranked current Models", () => {
    const models = [
      { ...sampleModels[1]!, id: "claude-3-5-haiku", name: "Claude 3.5 Haiku" },
      { ...sampleModels[1]!, id: "claude-3-haiku", name: "Claude 3 Haiku" },
    ];
    expect(resolveModelQuery(models, "haiku", null).model?.id).toBe("claude-3-haiku");
  });

  it("reports no match instead of inventing a Model", () => {
    const resolution = resolveModelQuery(sampleModels, "definitely-not-a-model", null);
    expect(resolution.model).toBeNull();
    expect(resolution.matches).toEqual([]);
  });

  it("suggests a few current Model names for error feedback", () => {
    expect(modelNameSuggestions(sampleModels, 2)).toEqual(["Claude 3.7 Sonnet", "Claude 3.5 Haiku"]);
  });
});
