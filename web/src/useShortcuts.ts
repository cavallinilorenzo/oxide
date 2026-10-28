import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type SettingsState } from "./bindings";
import { DEFAULT_SHORTCUTS, type Shortcuts } from "./shortcuts";

// One shared copy of the user's shortcuts: every component that reads them sees a change
// the moment Settings are saved or `settings.json` is edited.
let current: Shortcuts = DEFAULT_SHORTCUTS;
let started = false;
const subscribers = new Set<() => void>();

function apply(state: Pick<SettingsState, "settings"> | null | undefined) {
  const next = { ...DEFAULT_SHORTCUTS, ...(state?.settings?.shortcuts ?? {}) };
  if (Object.keys(next).every((key) => next[key as keyof Shortcuts] === current[key as keyof Shortcuts])) return;
  current = next;
  subscribers.forEach((notify) => notify());
}

function start() {
  if (started) return;
  started = true;
  void Promise.resolve(commands.getSettings()).then(apply).catch(() => {});
  void listen<SettingsState>("settings-changed", (event) => apply(event.payload)).catch(() => {});
}

function subscribe(notify: () => void) {
  start();
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

/** The shortcuts in effect: Settings' once loaded, the defaults before. */
export function useShortcuts(): Shortcuts {
  return useSyncExternalStore(subscribe, () => current);
}
