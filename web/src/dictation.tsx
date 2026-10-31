import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import { commands } from "./bindings";
import { actionForKey, formatAccelerator } from "./shortcuts";
import { useShortcuts } from "./useShortcuts";

export function dictationLine(text: string): string { return [...text].map((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c).join(""); }

type Target = { element: HTMLElement; insert: (text: string) => void };
const targets = new Map<HTMLElement, Target>();
const listeners = new Set<() => void>();
type State = { phase: "idle" | "starting" | "recording" | "transcribing"; error: string | null; notice?: string; retry?: boolean };
let state: State = { phase: "idle", error: null };
let destination: Target | undefined;
let caret: Range | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
function update(next: State) { state = next; listeners.forEach((fn) => fn()); }
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
export function useDictationState() { return useSyncExternalStore(subscribe, () => state); }

function playDictationStartSound() {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    // Pleasant ascending chime: 587.33 Hz (D5) -> 880 Hz (A5)
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);
    osc.onended = () => { void ctx.close(); };
  } catch {
    // Audio context failure should not impede dictation
  }
}

export function useDictationTarget(ref: RefObject<HTMLElement | null>, insert: (text: string) => void, enabled = true) {
  const latest = useRef(insert);
  useLayoutEffect(() => { latest.current = insert; });
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const target: Target = { element, insert: (text) => latest.current(text) };
    targets.set(element, target);
    return () => { targets.delete(element); };
  }, [ref, enabled]);
}
function insertResult(text: string) {
  if (!text) return;
  if (!destination || !destination.element.isConnected || targets.get(destination.element) !== destination) throw new Error("The original input was closed. Dictation was discarded.");
  destination.element.focus();
  if (caret && destination.element.contains(caret.startContainer)) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(caret); }
  destination.insert(text);
}
export async function retryDictationOnCpu() {
  if (!state.retry || state.phase !== "idle") return;
  const version = generation;
  update({ phase: "transcribing", error: null });
  try {
    const result = await commands.dictationRetryOnCpu();
    if (version !== generation) return;
    if (result.status === "error") throw new Error(result.error.message);
    insertResult(result.data);
    update({ phase: "idle", error: null });
  } catch (error) {
    if (version === generation) update({ phase: "idle", error: message(error), retry: /^GPU transcription failed|CPU retry refused|CPU transcription failed/.test(message(error)) });
    return;
  }
  destination = undefined;
}
export function toggleDictation(element: Element | null = document.activeElement) {
  void toggle(element);
}
async function toggle(element: Element | null) {
  if (state.phase === "starting" || state.phase === "transcribing") return;
  if (state.phase === "recording") {
    clearTimeout(timer);
    const version = generation;
    update({ phase: "transcribing", error: null });
    try {
      const result = await commands.dictationStop();
      if (version !== generation) return;
      if (result.status === "error") throw new Error(result.error.message);
      insertResult(result.data);
      update({ phase: "idle", error: null });
      void commands.dictationStatus().then(result => {
        if (version !== generation || state.phase !== "idle" || result.status !== "ok") return;
        const execution = result.data.lastExecution;
        if (execution?.backend === "cpu" && execution.fallbackReason) {
          update({ phase: "idle", error: null, notice: `Fell back to CPU: ${execution.fallbackReason}` });
        }
      }).catch(() => {});
    } catch (error) {
      const retry = /^GPU transcription failed/.test(message(error));
      if (version === generation) update({ phase: "idle", error: message(error), retry });
      if (retry) return;
    }
    destination = undefined;
    return;
  }
  destination = [...targets.values()].filter((target) => element && target.element.contains(element) && target.element.getClientRects().length > 0).at(-1);
  if (!destination) { update({ phase: "idle", error: "Focus a chat composer or terminal before starting dictation." }); return; }
  const selection = window.getSelection();
  caret = selection?.rangeCount && destination.element.contains(selection.getRangeAt(0).startContainer) ? selection.getRangeAt(0).cloneRange() : undefined;
  const version = ++generation;
  update({ phase: "starting", error: null });
  try {
    const result = await commands.dictationStart();
    if (version !== generation) { await commands.dictationCancel(); return; }
    if (result.status === "error") throw new Error(result.error.message);
    playDictationStartSound();
    update({ phase: "recording", error: null });
    timer = setTimeout(() => { void toggle(null); }, 119_000);
  } catch (error) { if (version === generation) update({ phase: "idle", error: message(error) }); }
}
export function cancelDictation() {
  generation++; clearTimeout(timer); destination = undefined;
  void commands.dictationCancel(); update({ phase: "idle", error: null });
}
export function DictationController() {
  const shortcuts = useShortcuts(); const current = useDictationState();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (actionForKey(event, shortcuts) === "dictation") {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) toggleDictation();
      } else if (event.key === "Escape" && state.phase !== "idle") { event.preventDefault(); event.stopImmediatePropagation(); cancelDictation(); }
    };
    const visibility = () => { if (document.hidden && state.phase !== "idle") cancelDictation(); };
    document.addEventListener("keydown", key, true); document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("visibilitychange", visibility); cancelDictation(); };
  }, [shortcuts]);
  if (current.phase === "idle" && !current.error && !current.notice) return null;
  return <aside className="dictation-status" aria-label="Dictation">
    <span role={current.error ? "alert" : "status"}>{current.error ?? current.notice ?? (current.phase === "recording" ? `Listening — ${formatAccelerator(shortcuts.dictation)} to insert, Esc to cancel` : current.phase === "starting" ? "Preparing model and microphone…" : "Transcribing locally…")}</span>
    {current.retry && current.phase === "idle" && <button type="button" onClick={() => { void retryDictationOnCpu(); }}>Retry on CPU</button>}
    <button type="button" onClick={cancelDictation}>{current.phase === "idle" ? "Dismiss" : "Cancel"}</button>
  </aside>;
}
