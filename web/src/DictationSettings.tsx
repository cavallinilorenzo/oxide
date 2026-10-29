import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type DictationSettings as Value, type DictationStatus } from "./bindings";
import { Dropdown } from "./Dropdown";

export function DictationSettings({ value, onChange }: { value: Value; onChange: (value: Value) => void }) {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void commands.dictationStatus().then((r) => { if (active && r.status === "ok") setStatus(r.data); }).catch(() => {});
    const stop = listen<[number, number]>("dictation-download", ({ payload: [received, total] }) => { if (active) setProgress(Math.min(100, Math.round(received / total * 100))); });
    return () => { active = false; void stop.then((fn) => fn()).catch(() => {}); };
  }, []);
  const download = async () => {
    setBusy(true); setError(null); setProgress(0);
    try {
      const result = await commands.dictationInstall();
      if (result.status === "error") throw new Error(result.error.message);
      const next = await commands.dictationStatus(); if (next.status === "ok") setStatus(next.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section" aria-labelledby="settings-dictation">
    <header className="settings-section-header"><h2 id="settings-dictation">Dictation</h2><p>Whisper small transcribes on this computer. Audio stays in memory and is discarded after transcription.</p></header>
    <div className="settings-card">
      <label className="inline"><input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />Enable dictation</label>
      <p>Use the dictation shortcut to start and stop recording in the focused chat or terminal. Text is inserted for review. Recordings stop after two minutes.</p>
      <div className="settings-fields">
        <label className="settings-field">Language code<input aria-label="Dictation language" value={value.language} placeholder="auto, it, en, fr…" onChange={(e) => onChange({ ...value, language: e.target.value.trim().toLowerCase() })} /><small>Use auto to detect the language, or a Whisper language code such as it for Italian.</small></label>
        <div className="settings-field"><span>Run on</span><Dropdown label="Dictation device" value={value.device} options={[{ value: "cpu", label: "CPU" }, { value: "gpu", label: "GPU" }]} onChange={(device) => onChange({ ...value, device })} />
          {value.device === "gpu" && !status?.gpuCompiled && <p className="error">GPU support is unavailable in this build. Choose CPU, or install a build with GPU support.</p>}
          {value.device === "gpu" && status?.gpuCompiled && <small>Requires a compatible GPU and driver. Available VRAM and speed have not been benchmarked.</small>}
        </div>
      </div>
      {status && <p>{(status.availableMemoryGb ?? 0).toFixed(1)} GB RAM available · {status.cpuThreads} CPU threads. {status.recommendation}</p>}
      {status?.installed ? <p>Whisper small is installed (466 MiB).</p> : <button type="button" disabled={busy} onClick={() => void download()}>{busy ? `Downloading Whisper small… ${progress}%` : "Download Whisper small (466 MiB)"}</button>}
      {busy && <progress aria-label="Whisper small download" value={progress} max={100} />}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </section>;
}
