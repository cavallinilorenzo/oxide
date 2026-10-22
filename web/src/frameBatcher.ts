export interface FrameScheduler {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

export interface FrameBatcher<T> {
  push: (value: T) => void;
  /** Drops anything pushed but not yet flushed. */
  cancel: () => void;
}

/**
 * Collects values and hands them to `flush` at most once per frame, so a
 * stream of per-token updates becomes one React update per frame.
 */
export function createFrameBatcher<T>(
  flush: (batch: T[]) => void,
  frames: FrameScheduler = animationFrames
): FrameBatcher<T> {
  let pending: T[] = [];
  let frame = 0;
  return {
    push(value) {
      pending.push(value);
      if (frame) return;
      frame = frames.request(() => {
        frame = 0;
        const batch = pending;
        pending = [];
        flush(batch);
      });
    },
    cancel() {
      if (frame) frames.cancel(frame);
      frame = 0;
      pending = [];
    },
  };
}
