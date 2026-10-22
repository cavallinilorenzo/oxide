/** Joins at most 64 KiB from queued PTY chunks into one frame's xterm write. */
export function takeFrameBatch(pending: Uint8Array[], maxBytes = 64 * 1024): Uint8Array {
  let remaining = maxBytes;
  const parts: Uint8Array[] = [];
  while (pending.length > 0 && remaining > 0) {
    const chunk = pending[0];
    const count = Math.min(chunk.length, remaining);
    parts.push(chunk.subarray(0, count));
    remaining -= count;
    if (count === chunk.length) pending.shift();
    else pending[0] = chunk.subarray(count);
  }
  const batch = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    batch.set(part, offset);
    offset += part.length;
  }
  return batch;
}
