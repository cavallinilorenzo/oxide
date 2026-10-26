import { describe, expect, it } from "vitest";
import { filterSlashCommands, slashQuery } from "./slashMenu";

const cmds = [
  { name: "tdd", description: null },
  { name: "git:sync", description: "Sync" },
  { name: "ship", description: null },
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
    expect(filterSlashCommands(cmds, "").map((c) => c.name)).toEqual(["tdd", "git:sync", "ship"]);
  });
  it("ranks prefix matches before substring matches", () => {
    expect(filterSlashCommands(cmds, "s").map((c) => c.name)).toEqual(["ship", "git:sync"]);
  });
});
