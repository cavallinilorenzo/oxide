import { describe, expect, it } from "vitest";
import { pageRequest, pagesToLoad, turnAt } from "./transcriptPages";
import type { TurnSnapshot } from "./bindings";
import { initialTranscriptState } from "./transcript";

function turn(position: number): TurnSnapshot {
  return {
    id: position + 1,
    turnIndex: 0,
    prompt: `prompt ${position}`,
    segments: [],
    status: "completed",
    startedAt: "",
    completedAt: null,
    items: [],
    approvals: [],
    unknownEvents: [],
  };
}

describe("transcript pages", () => {
  it("loads only the pages under the visible range when jumping far back", () => {
    expect(pagesToLoad(3, 20, 9950, () => false)).toEqual([0]);
    expect(pagesToLoad(5020, 5130, 9950, () => false)).toEqual([100, 101, 102]);
  });

  it("never loads pages for the live tail", () => {
    expect(pagesToLoad(9940, 9999, 9950, () => false)).toEqual([198]);
    expect(pagesToLoad(9950, 9999, 9950, () => false)).toEqual([]);
  });

  it("skips pages already loaded or in flight", () => {
    expect(pagesToLoad(0, 149, 9950, (page) => page === 1)).toEqual([0, 2]);
  });

  it("requests a page clipped where the live tail begins", () => {
    expect(pageRequest(0, 9950)).toEqual({ offset: 0, limit: 50 });
    expect(pageRequest(198, 9930)).toEqual({ offset: 9900, limit: 30 });
  });

  it("finds a Turn by position in the live tail or a loaded page", () => {
    const transcript = {
      ...initialTranscriptState(null),
      turns: [turn(120), turn(121)],
      turnOffset: 120,
    };
    const pages = new Map([[1, Array.from({ length: 50 }, (_, i) => turn(50 + i))]]);

    expect(turnAt(121, transcript, pages)?.prompt).toBe("prompt 121");
    expect(turnAt(73, transcript, pages)?.prompt).toBe("prompt 73");
    expect(turnAt(10, transcript, pages)).toBeUndefined();
    expect(turnAt(122, transcript, pages)).toBeUndefined();
  });
});
