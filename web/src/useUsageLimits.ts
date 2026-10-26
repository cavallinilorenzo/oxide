import { useEffect, useState, useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { commands, type UsageLimits, type UsageLimits_Deserialize } from "./bindings";

/** When this run of Oxide started: figures reported before it are from an earlier session. */
export const SESSION_START_MS = Date.now();

interface Entry {
  limits: UsageLimits | null;
  listeners: Set<() => void>;
}

// One subscription per Provider, shared by every Thread of it, kept for the life of the window.
const entries = new Map<string, Entry>();

function entryFor(provider: string): Entry {
  const existing = entries.get(provider);
  if (existing) return existing;
  const created: Entry = { limits: null, listeners: new Set() };
  entries.set(provider, created);
  const publish = (limits: UsageLimits) => {
    created.limits = limits;
    created.listeners.forEach((listener) => listener());
  };
  const channel = new Channel<UsageLimits_Deserialize>();
  channel.onmessage = publish;
  void commands.subscribeUsageLimits(provider, channel).then((res) => {
    // An update that raced the snapshot is newer than it.
    if (res.status === "ok" && res.data && !created.limits) publish(res.data);
  });
  return created;
}

/** The Provider's latest Usage limits, updating as Turns run; `null` until any were seen. */
export function useUsageLimits(provider: string, enabled: boolean): UsageLimits | null {
  return useSyncExternalStore(
    (listener) => {
      if (!enabled) return () => {};
      const entry = entryFor(provider);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    () => (enabled ? (entries.get(provider)?.limits ?? null) : null),
  );
}

/** The current time, refreshed every `intervalMs`. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
