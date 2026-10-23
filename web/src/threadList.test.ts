import { describe, expect, it } from "vitest";
import type { Project, Thread } from "./bindings";
import { relativeAge, sidebarProjects, splitThreads } from "./threadList";

const thread = (id: number, archived = false) => ({ id, archived }) as Thread;

describe("splitThreads", () => {
  const threads = [thread(1), thread(12, true), thread(3, true), thread(21)];

  it("keeps archived Threads out of the sidebar list", () => {
    const { active, archived } = splitThreads(threads, "");
    expect(active.map((t) => t.id)).toEqual([1, 21]);
    expect(archived.map((t) => t.id)).toEqual([12, 3]);
  });

  it("filters both lists by title", () => {
    const { active, archived } = splitThreads(threads, " #1");
    expect(active.map((t) => t.id)).toEqual([1]);
    expect(archived.map((t) => t.id)).toEqual([12]);
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
