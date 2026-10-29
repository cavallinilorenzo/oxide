import { invoke } from "@tauri-apps/api/core";

// Share concurrent requests between the composer and Transcript, without retaining image data.
const pending = new Map<string, Promise<string | null>>();
export function attachmentPreview(id: string): Promise<string | null> {
  const existing = pending.get(id);
  if (existing) return existing;
  const request = invoke<string | null>("attachment_preview", { id }).catch(() => null).finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}
