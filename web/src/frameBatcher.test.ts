import { describe, expect, it } from "vitest";
import { createFrameBatcher } from "./frameBatcher";

/** A hand-cranked animation-frame clock. */
function fakeFrames() {
  let callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    request: (cb: () => void) => {
      callbacks.set(next, cb);
      return next++;
    },
    cancel: (id: number) => void callbacks.delete(id),
    tick: () => {
      const due = callbacks;
      callbacks = new Map();
      due.forEach((cb) => cb());
    },
    pending: () => callbacks.size,
  };
}

describe("frame batcher", () => {
  it("flushes everything pushed during a frame once, on the next frame", () => {
    const frames = fakeFrames();
    const flushes: number[][] = [];
    const batcher = createFrameBatcher<number>((batch) => flushes.push(batch), frames);

    for (let i = 0; i < 500; i++) batcher.push(i);
    expect(flushes).toEqual([]);
    expect(frames.pending()).toBe(1);

    frames.tick();
    expect(flushes.length).toBe(1);
    expect(flushes[0].length).toBe(500);

    batcher.push(500);
    batcher.push(501);
    frames.tick();
    expect(flushes).toEqual([flushes[0], [500, 501]]);
  });

  it("does not flush on a frame with nothing pushed", () => {
    const frames = fakeFrames();
    const flushes: number[][] = [];
    createFrameBatcher<number>((batch) => flushes.push(batch), frames);
    frames.tick();
    expect(flushes).toEqual([]);
    expect(frames.pending()).toBe(0);
  });

  it("drops pending items when cancelled", () => {
    const frames = fakeFrames();
    const flushes: number[][] = [];
    const batcher = createFrameBatcher<number>((batch) => flushes.push(batch), frames);
    batcher.push(1);
    batcher.cancel();
    frames.tick();
    expect(flushes).toEqual([]);
  });
});
