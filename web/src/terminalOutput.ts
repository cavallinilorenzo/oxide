/** Joins at most 64 KiB from queued PTY chunks into one frame's xterm write. */
export function takeFrameBatch(pending: Uint8Array[], maxBytes = 64 * 1024): Uint8Array {
  let remaining = maxBytes;
  const parts: Uint8Array[] = [];
  let consumed = 0;
  while (consumed < pending.length && remaining > 0) {
    const chunk = pending[consumed];
    const count = Math.min(chunk.length, remaining);
    parts.push(chunk.subarray(0, count));
    remaining -= count;
    if (count === chunk.length) {
      consumed++;
    } else {
      pending[consumed] = chunk.subarray(count);
      break;
    }
  }
  if (consumed > 0) {
    pending.splice(0, consumed);
  }
  const batch = new Uint8Array(maxBytes - remaining);
  let offset = 0;
  for (const part of parts) {
    batch.set(part, offset);
    offset += part.length;
  }
  return batch;
}
