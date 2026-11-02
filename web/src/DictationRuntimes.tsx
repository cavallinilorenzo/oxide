import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type AvailableRuntime, type BackendId, type InstalledRuntime, type RuntimeCatalogue } from "./bindings";

/** Payload of the `dictation-runtime-progress` event (not a command type, so not generated). */
type RuntimeProgress = { backend: BackendId; received: number; total: number };

export const RUNTIMES_SECTION_ID = "dictation-runtimes";
const BACKENDS: { id: BackendId; name: string }[] = [
  { id: "vulkan", name: "Vulkan" },
  { id: "cuda", name: "CUDA" },
];
const size = (n: number | null | undefined) => n == null ? "Unknown size" : n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GiB` : `${(n / 1048576).toFixed(1)} MiB`;
const parts = (v: string) => v.split(/\D+/).filter(Boolean).map(Number);
/** Same ordering as the core: numeric segments compared left to right. */
export function isNewer(candidate: string, current: string) {
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
const newest = <T extends { version: string }>(items: T[]) => items.reduce<T | undefined>((best, item) => !best || isNewer(item.version, best.version) ? item : best, undefined);
const message = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === "object" && cause && "message" in cause ? String((cause as { message: unknown }).message) : String(cause);

/** Opens the runtimes section and moves focus to it (used by the "CPU support only" prompts). */
export function focusRuntimes() {
  const section = document.getElementById(RUNTIMES_SECTION_ID);
  if (!section) return;
  section.scrollIntoView?.({ block: "start" });
  section.focus();
}

export function DictationRuntimes({ onChanged }: { onChanged: () => void }) {
  const [catalogue, setCatalogue] = useState<RuntimeCatalogue | null>(null);
  const [progress, setProgress] = useState<Partial<Record<BackendId, RuntimeProgress>>>({});
  const [busy, setBusy] = useState<Set<BackendId>>(new Set());
  const [errors, setErrors] = useState<Partial<Record<BackendId, string>>>({});
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(new Set<BackendId>());

  const load = useCallback(async () => {
    try {
      const response = await commands.dictationRuntimes();
      if (response.status === "error") throw new Error(response.error.message);
      if (!active.current) return;
      setCatalogue(response.data);
      setLoadError(null);
      setBusy(old => new Set([...old, ...response.data.installing]));
    } catch (cause) { if (active.current) setLoadError(message(cause)); }
  }, []);

  useEffect(() => {
    active.current = true;
    const stop = listen<RuntimeProgress>("dictation-runtime-progress", ({ payload }) => {
      if (active.current) setProgress(old => ({ ...old, [payload.backend]: payload }));
    });
    void stop.catch(() => {});
    void load();
    return () => { active.current = false; void stop.then(fn => fn()).catch(() => {}); };
  }, [load]);

  const install = async (backend: BackendId, name: string, update: boolean) => {
    if (pending.current.has(backend)) return;
    pending.current.add(backend);
    setBusy(new Set(pending.current)); setErrors(old => ({ ...old, [backend]: undefined })); setNotice("");
    try {
      const response = await commands.dictationRuntimeInstall(backend);
      if (response.status === "error") throw new Error(response.error.message);
      if (active.current) {
        setNotice(`${name} runtime ${response.data.version} ${update ? "updated" : "installed"}. It is used from the next dictation, no restart needed.`);
        onChanged();
      }
    } catch (cause) {
      const text = message(cause);
      if (active.current) {
        if (/cancelled/i.test(text)) setNotice(`${name} download cancelled. Nothing was changed.`);
        else setErrors(old => ({ ...old, [backend]: text }));
      }
    } finally {
      pending.current.delete(backend);
      if (active.current) { setBusy(new Set(pending.current)); setProgress(old => ({ ...old, [backend]: undefined })); void load(); }
    }
  };
  const cancel = (backend: BackendId) => { void commands.dictationRuntimeCancel(backend); };
  const remove = async (backend: BackendId, name: string) => {
    if (pending.current.has(backend)) return;
    pending.current.add(backend);
    setBusy(new Set(pending.current)); setErrors(old => ({ ...old, [backend]: undefined })); setNotice("");
    try {
      const response = await commands.dictationRuntimeRemove(backend);
      if (response.status === "error") throw new Error(response.error.message);
      if (active.current) { setNotice(`${name} runtime removed. CPU dictation is unaffected.`); onChanged(); }
    } catch (cause) { if (active.current) setErrors(old => ({ ...old, [backend]: message(cause) })); }
    finally { pending.current.delete(backend); if (active.current) { setBusy(new Set(pending.current)); void load(); } }
  };

  return (
    <div className="dictation-runtimes" id={RUNTIMES_SECTION_ID} tabIndex={-1} aria-labelledby="dictation-runtimes-title">
      <div className="dictation-models-header">
        <h3 id="dictation-runtimes-title">GPU runtimes</h3>
        <p className="dictation-models-subtitle">
          Optional downloads that let Whisper use your graphics card. Each package is signed and verified before it is installed. CPU always keeps working, with or without them.
        </p>
      </div>
      {loadError && <p className="error" role="alert">Could not read the runtimes: {loadError}</p>}
      {catalogue?.indexError && (
        <p className="warning-text" role="status">Could not read the list of available runtimes: {catalogue.indexError}. Installed runtimes still work; CPU is unaffected.</p>
      )}
      <div className="dictation-models">
        {BACKENDS.map(({ id, name }) => {
          const installed: InstalledRuntime[] = catalogue?.installed.filter(r => r.backend === id) ?? [];
          const current = newest(installed);
          const published: AvailableRuntime | undefined = newest(catalogue?.available.filter(r => r.backend === id) ?? []);
          const working = busy.has(id);
          const received = progress[id];
          const incompatible = current && !current.compatible;
          const updatable = !!published && !!current && (incompatible || isNewer(published.version, current.version));
          const state = working ? "Installing…" : incompatible ? "Incompatible" : updatable ? "Update available" : current ? "Installed" : "Not installed";
          return (
            <article key={id} className="dictation-model" aria-label={`Runtime ${name}`}>
              <div className="dictation-model-head">
                <h4>{name}</h4>
                <span className={`status-pill status-${incompatible ? "error" : current ? "installed" : "unknown"}`}>{state}</span>
              </div>
              <div className="dictation-model-meta">
                <span>{current ? `Installed: ${current.version} · ${size(current.bytes)}` : "Not installed"}</span>
                <span>{published ? `Available: ${published.version} · ${size(published.bytes)}` : catalogue ? "No published version for this system" : "Checking…"}</span>
                {published?.requirements && <span>Requires: {published.requirements}</span>}
              </div>
              {incompatible && (
                <p className="error" role="alert">
                  This runtime speaks worker protocol {current.protocolVersion} but this app needs {catalogue?.protocolVersion}. It is not used.
                  {published ? " Update it to a compatible version or remove it." : " Remove it, or wait for a compatible release."}
                </p>
              )}
              {working && (
                <progress
                  aria-label={`${name} runtime download`}
                  max={received?.total || undefined}
                  value={received && received.total ? received.received ?? undefined : undefined}
                />
              )}
              {errors[id] && <p className="error" role="alert">{errors[id]} CPU is still available.</p>}
              <div className="dictation-actions">
                {working ? (
                  <button type="button" onClick={() => cancel(id)}>Cancel {name} runtime download</button>
                ) : (
                  <>
                    {!current && <button type="button" className="download-action" disabled={!published} onClick={() => void install(id, name, false)}>Install {name} runtime</button>}
                    {updatable && <button type="button" className="primary-action" onClick={() => void install(id, name, true)}>Update {name} runtime</button>}
                    {current && <button type="button" className="danger-action" onClick={() => void remove(id, name)}>Remove {name} runtime</button>}
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {notice && <p role="status" className="notice-text">{notice}</p>}
    </div>
  );
}
