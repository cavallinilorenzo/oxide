import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./bindings";
import { filterSlashCommands, pickSlashCommand, slashQuery } from "./slashMenu";

const cmd = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: null,
  argumentHint: null,
  aliases: [],
  route: "passthrough",
  ...extra,
});

const cmds = [
  cmd("tdd"),
  cmd("git:sync", { description: "Sync" }),
  cmd("ship"),
  cmd("clear", { aliases: ["reset", "new"], route: "oxide" }),
];

describe("slashQuery", () => {
  it("opens on a lone slash word only", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/sh")).toBe("sh");
    expect(slashQuery("/ship now")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("lists everything for an empty query", () => {
    expect(filterSlashCommands(cmds, "").map((c) => c.name)).toEqual([
      "tdd",
      "git:sync",
      "ship",
      "clear",
    ]);
  });
  it("ranks prefix matches before substring matches", () => {
    expect(filterSlashCommands(cmds, "s").map((c) => c.name)).toEqual(["ship", "git:sync", "clear"]);
  });
  it("matches aliases once per command", () => {
    expect(filterSlashCommands(cmds, "res").map((c) => c.name)).toEqual(["clear"]);
  });
});

describe("pickSlashCommand", () => {
  const withArg = cmd("compact", { argumentHint: "<instructions>" });
  it("completes to `/name ` when the command takes an argument", () => {
    expect(pickSlashCommand(withArg, "Enter", "/comp")).toEqual({ insert: "/compact " });
  });
  it("completes a command without an argument, then runs it on the next Enter", () => {
    const context = cmd("context");
    expect(pickSlashCommand(context, "Enter", "/con")).toEqual({ insert: "/context" });
    expect(pickSlashCommand(context, "Enter", "/context")).toEqual({ submit: true });
  });
  it("completes on Tab regardless", () => {
    expect(pickSlashCommand(cmd("context"), "Tab", "/con")).toEqual({ insert: "/context " });
  });
});
