import { describe, expect, it } from "vitest";
import type { Thread } from "./bindings";
import { splitThreads } from "./threadList";

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
