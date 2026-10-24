import { describe, expect, it } from "vitest";
import type { Project, Thread } from "./bindings";
import { filterThreads, relativeAge, sidebarProjects } from "./threadList";

const thread = (id: number) => ({ id }) as Thread;

describe("filterThreads", () => {
  const threads = [thread(1), thread(12), thread(3), thread(21)];

  it("keeps every Thread without a query", () => {
    expect(filterThreads(threads, "").map((t) => t.id)).toEqual([1, 12, 3, 21]);
  });

  it("filters by title", () => {
    expect(filterThreads(threads, " #1").map((t) => t.id)).toEqual([1, 12]);
  });
});

describe("sidebarProjects", () => {
  const project = (id: number, open: boolean, hidden = false) => ({ id, open, hidden }) as Project;

  it("lists only the Projects the user opened, never hidden ones", () => {
    const listed = sidebarProjects([project(1, true), project(2, false), project(3, true, true)]);
    expect(listed.map((p) => p.id)).toEqual([1]);
  });
});

describe("relativeAge", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

  it("counts minutes, hours and days", () => {
    expect(relativeAge(ago(0), now)).toBe("now");
    expect(relativeAge(ago(5), now)).toBe("5m");
    expect(relativeAge(ago(180), now)).toBe("3h");
    expect(relativeAge(ago(26 * 60), now)).toBe("yesterday");
    expect(relativeAge(ago(4 * 24 * 60), now)).toBe("4d");
  });

  it("is empty for an unreadable time", () => {
    expect(relativeAge("not a date", now)).toBe("");
  });
});
