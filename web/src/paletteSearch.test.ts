import { describe, expect, it } from "vitest";
import { isProjectPaletteShortcut } from "./shortcuts";
import { matchActions, matchProjects, moveHighlight } from "./paletteSearch";

const press = (key: string, mods: Partial<Parameters<typeof isProjectPaletteShortcut>[0]> = {}) =>
  isProjectPaletteShortcut({
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    ...mods,
  });

describe("isProjectPaletteShortcut", () => {
  it("is ⌘⇧N, whatever the case the browser reports", () => {
    expect(press("n")).toBe(true);
    expect(press("N")).toBe(true);
  });
  it("is not ⌘N, nor other chords", () => {
    expect(press("n", { shiftKey: false })).toBe(false);
    expect(press("n", { metaKey: false })).toBe(false);
    expect(press("n", { altKey: true })).toBe(false);
    expect(press("p")).toBe(false);
  });
});

const project = (id: number, name: string, extra: object = {}) => ({
  id,
  name,
  path: `/code/${name}`,
  hidden: false,
  missing: false,
  ...extra,
});

describe("matchProjects", () => {
  const projects = [
    project(1, "oxide"),
    project(2, "side-project"),
    project(3, "oxygen-docs"),
    project(4, "old", { hidden: true }),
    project(5, "gone", { missing: true }),
  ];

  it("lists every visible, present Project for an empty query", () => {
    expect(matchProjects(projects, "").map((p) => p.id)).toEqual([1, 2, 3]);
  });
  it("matches names case-insensitively, prefix matches first", () => {
    expect(matchProjects(projects, "OX").map((p) => p.id)).toEqual([1, 3]);
    expect(matchProjects(projects, "ide").map((p) => p.id)).toEqual([1, 2]);
    expect(matchProjects(projects, "proj").map((p) => p.id)).toEqual([2]);
    expect(matchProjects([project(1, "my-ox"), project(2, "ox")], "ox").map((p) => p.id)).toEqual([2, 1]);
  });
  it("matches letters in order, not only substrings", () => {
    expect(matchProjects(projects, "oxd").map((p) => p.id)).toEqual([1, 3]);
  });
  it("falls back to the path", () => {
    expect(matchProjects([project(1, "oxide", { path: "/work/acme/oxide" })], "acme")).toHaveLength(1);
  });
  it("never offers hidden or missing Projects", () => {
    expect(matchProjects(projects, "old")).toEqual([]);
    expect(matchProjects(projects, "gone")).toEqual([]);
  });
});

describe("matchActions", () => {
  it("offers every action for an empty query", () => {
    expect(matchActions("").map((a) => a.id)).toEqual([
      "add-folder",
      "new-project",
      "clone-url",
      "clone-github",
    ]);
  });
  it("filters by label", () => {
    expect(matchActions("github").map((a) => a.id)).toEqual(["clone-github"]);
    expect(matchActions("zzz")).toEqual([]);
  });
});

describe("moveHighlight", () => {
  it("wraps around in both directions", () => {
    expect(moveHighlight(0, 3, 1)).toBe(1);
    expect(moveHighlight(2, 3, 1)).toBe(0);
    expect(moveHighlight(0, 3, -1)).toBe(2);
  });
  it("stays at 0 when there is nothing to highlight", () => {
    expect(moveHighlight(0, 0, 1)).toBe(0);
  });
});
