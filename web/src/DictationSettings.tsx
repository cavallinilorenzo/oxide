import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { commands, type AdvicePreference, type BackendCandidate, type CapabilityState, type DictationBenchmarkProgress, type DictationBenchmarkResult, type DictationModelEntry, type DictationModelId, type DictationModelStatus, type DictationSettings as Value, type DictationStatus } from "./bindings";
import { Dropdown } from "./Dropdown";
import { cancelDictation, useDictationState } from "./dictation";

const bytes = (n: number | null | undefined) => n == null ? "Unknown" : `${(n / 1073741824).toFixed(2)} GiB`;
const backendName = (s: string) => s === "cpu" ? "CPU" : s === "gpu" ? "GPU" : s === "auto" ? "Auto" : s[0].toUpperCase() + s.slice(1);
function capability(state: CapabilityState): string {
  switch (state.status) {
    case "omittedFromBuild": return "Not included in this build. Install a build with this backend, or use CPU.";
    case "noCompatibleDevice": return "No compatible device. Connect a supported GPU, refresh, or use CPU.";
    case "missingDriverOrRuntime": return "Driver/runtime unavailable. Update the graphics driver, refresh, or use CPU.";
    case "initializationFailure": return `Initialization failed: ${state.details}. Refresh after repairing the driver, or use CPU.`;
    case "insufficientMemory": return "Insufficient memory. Close other apps, select a smaller model, or use CPU.";
    case "available": return "Available; execution has not been verified by inference.";
    case "verifiedByInference": return "Verified by inference.";
  }
}
const usable = (candidate: BackendCandidate) => ["available", "verifiedByInference"].includes(candidate.probe.state.status);

export function DictationSettings({ value, onChange }: { value: Value; onChange: (value: Value) => void }) {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [entries, setEntries] = useState<DictationModelEntry[]>([]);
  const [models, setModels] = useState<DictationModelStatus[]>([]);
  const [operations, setOperations] = useState<Set<DictationModelId>>(new Set());
  const [preference, setPreference] = useState<AdvicePreference>("balanced");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<DictationBenchmarkProgress | null>(null);
  const [results, setResults] = useState<DictationBenchmarkResult[]>([]);
  const active = useRef(false);
  const pending = useRef(new Set<DictationModelId>());
  const benchmark = useRef(0);
  const running = useRef(false);
  const refreshVersion = useRef(0);
  const capture = useDictationState();
  const fail = (cause: unknown) => { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); };
  const refresh = async (choice: AdvicePreference = preference) => {
    const version = ++refreshVersion.current;
    setRefreshing(true);
    try {
      const response = await commands.dictationAdvice(choice);
      if (response.status === "error") throw new Error(response.error.message);
      if (active.current && version === refreshVersion.current) setStatus(response.data);
    } catch (cause) { fail(cause); }
    finally { if (active.current && version === refreshVersion.current) setRefreshing(false); }
  };
  useEffect(() => {
    active.current = true;
    let disposed = false;
    const changed = new Set<DictationModelId>();
    const stop = listen<DictationModelStatus>("dictation-model-download", ({ payload }) => {
      if (!active.current) return;
      changed.add(payload.id);
      setModels(old => [...old.filter(m => m.id !== payload.id), payload]);
    });
    void stop.catch(fail);
    void Promise.all([commands.dictationModelCatalogue(), commands.dictationModels(), commands.dictationStatus()]).then(([catalogue, installed, current]) => {
      if (disposed) return;
      setEntries(catalogue.models);
      if (installed.status === "error") throw new Error(installed.error.message);
      setModels(old => [...installed.data.filter(m => !changed.has(m.id)), ...old.filter(m => changed.has(m.id))]);
      if (current.status === "error") throw new Error(current.error.message);
      setStatus(current.data);
    }).catch(fail);
    return () => { disposed = true; active.current = false; if (running.current) void commands.dictationCancelPerformance().catch(() => {}); void stop.then(fn => fn()).catch(() => {}); };
  }, []);
  const operation = async (model: DictationModelId, action: "install" | "retry" | "delete") => {
    if (pending.current.has(model)) return;
    pending.current.add(model); setOperations(new Set(pending.current)); setError(null);
    try {
      const response = await (action === "delete" ? commands.dictationModelDelete(model) : action === "retry" ? commands.dictationModelRetry(model) : commands.dictationModelInstall(model));
      if (response.status === "error") throw new Error(response.error.message);
      const current = await commands.dictationModelStatus(model);
      if (current.status === "error") throw new Error(current.error.message);
      if (active.current) {
        setModels(old => [...old.filter(m => m.id !== model), current.data]);
        setNotice(`${model}: ${current.data.state.status}. Select explicitly when ready, then save Settings.`);
        void refresh();
      }
    } catch (cause) {
      fail(cause);
      if (active.current && action !== "delete") setModels(old => [...old.filter(m => m.id !== model), { id: model, state: { status: "error", message: cause instanceof Error ? cause.message : String(cause) } }]);
    }
    finally { pending.current.delete(model); if (active.current) setOperations(new Set(pending.current)); }
  };
  const cancelDownload = async (model: DictationModelId) => {
    try { await commands.dictationModelCancel(model); if (active.current) setNotice(`${model}: cancellation requested.`); } catch (cause) { fail(cause); }
  };
  const advice = status?.resourceAdvice;
  const report = advice?.recommendation;
  const recommended = report?.selected == null ? undefined : report.decisions[report.selected];
  const selectedModel = value.model ?? "small";
  const candidates = advice?.backends ?? [];
  const gpuCandidates = candidates.filter(c => c.probe.backend !== "cpu");
  const selectedCandidate = value.backend ? candidates.find(c => c.probe.backend === value.backend && (c.adapterId ?? null) === (value.adapterId ?? null)) : undefined;
  const benchmarkCandidate = value.device === "cpu" ? candidates.find(c => c.probe.backend === "cpu") : selectedCandidate ?? (value.device === "auto" && recommended?.model === selectedModel ? candidates.find(c => c.probe.backend === recommended.backend && c.adapterId === recommended.adapterId) : undefined);
  const installed = models.some(m => m.id === selectedModel && m.state.status === "installed");
  const selectedDecision = report?.decisions.find(d => d.model === selectedModel && d.backend === (value.device === "cpu" ? "cpu" : benchmarkCandidate?.probe.backend) && (d.adapterId ?? null) === (benchmarkCandidate?.adapterId ?? null));
  const check = async () => {
    if (running.current || !benchmarkCandidate || !installed) return;
    running.current = true; const version = ++benchmark.current;
    setChecking(true); setError(null); setResults([]); setProgress(null);
    try {
      const channel = new Channel<DictationBenchmarkProgress>();
      channel.onmessage = next => { if (active.current && version === benchmark.current) setProgress(next); };
      const response = await commands.dictationCheckPerformance({ model: selectedModel, backend: benchmarkCandidate.probe.backend, adapterId: benchmarkCandidate.adapterId, includeConservativeCandidate: true }, channel);
      if (!active.current || version !== benchmark.current) return;
      if (response.status === "error") throw new Error(response.error.message);
      setResults(response.data); setNotice("Performance check complete. Settings have not changed.");
      void refresh();
    } catch (cause) { if (version === benchmark.current) fail(cause); }
    finally { running.current = false; if (active.current) { setChecking(false); setProgress(null); } }
  };
  const cancelCheck = async () => {
    benchmark.current++;
    try { await commands.dictationCancelPerformance(); if (active.current) { setResults([]); setNotice("Performance check cancelled."); } } catch (cause) { fail(cause); }
  };
  return <section className="settings-section" aria-labelledby="settings-dictation">
    <header className="settings-section-header"><h2 id="settings-dictation">Dictation</h2><p>Whisper transcribes on this computer. Audio stays in memory and is discarded. Installed models work offline.</p></header>
    <div className="settings-card dictation-settings">
      <label className="inline"><input type="checkbox" checked={value.enabled} onChange={e => { if (!e.target.checked) { cancelDictation(); if (running.current) void cancelCheck(); } onChange({ ...value, enabled: e.target.checked }); }} />Enable dictation</label>
      <p>Use the rebindable dictation shortcut or chat microphone. Text goes to the original live chat or terminal for review, without submitting. Escape cancels; recordings stop after two minutes. Configure the shortcut in Keyboard shortcuts below.</p>
      <div className="settings-fields">
        <label className="settings-field">Language code<input aria-label="Dictation language" value={value.language} placeholder="auto, it, en, fr…" onChange={e => onChange({ ...value, language: e.target.value.trim().toLowerCase() })} /><small>Use auto or a supported Whisper language code, such as it. All models below are multilingual; unsupported codes are rejected on save.</small></label>
        <div className="settings-field"><span>Requested execution mode</span><Dropdown label="Dictation device" value={value.device} options={[{ value: "auto", label: "Auto" }, { value: "cpu", label: "CPU" }, { value: "gpu", label: "GPU" }]} onChange={device => onChange({ ...value, device })} /><small>Requested: {selectedModel} · {backendName(value.device)}{value.backend && value.device !== "cpu" ? ` · ${backendName(value.backend)} · ${value.adapterId ?? "default adapter"}` : ""}. Save Settings to apply.</small></div>
      </div>
      <details><summary>Advanced GPU backend and adapter</summary>
        <p>Auto can retry once on CPU when memory permits. Explicit GPU reports failure and offers CPU.</p>
        <label className="settings-field">GPU backend and adapter<select aria-label="GPU backend and adapter" value={selectedCandidate ? String(candidates.indexOf(selectedCandidate)) : ""} onChange={e => { const c = candidates[Number(e.target.value)]; onChange({ ...value, backend: e.target.value === "" ? null : c.probe.backend, adapterId: e.target.value === "" ? null : c.adapterId }); }}><option value="">Automatic backend / default adapter</option>{gpuCandidates.map(c => <option key={`${c.probe.backend}:${c.adapterId}`} value={candidates.indexOf(c)} disabled={!usable(c)}>{backendName(c.probe.backend)} · {c.probe.adapter ?? "Unknown adapter"}</option>)}</select></label>
        {value.backend && !selectedCandidate && <p role="status">Saved adapter is unavailable. Reconnect it, select another adapter or use CPU.</p>}
        <button type="button" onClick={() => onChange({ ...value, device: "cpu" })}>Use CPU</button>
      </details>
      <div aria-label="Runtime capability"><h3>Runtime capability</h3>{(candidates.length ? candidates.map(c => c.probe) : status?.probes ?? []).map((probe, i) => <p key={i}>{backendName(probe.backend)} · {probe.adapter ?? "Default device"}: {capability(probe.state)} {probe.memoryPool && `Memory ${bytes(probe.memoryPool.availableBytes)} available / ${bytes(probe.memoryPool.totalBytes)} total (${probe.memoryPool.unified ? "shared/unified pool" : "dedicated"}).`}</p>)}</div>
      <p role="status">Latest execution: {status?.lastExecution ? `${backendName(status.lastExecution.backend)} · ${status.lastExecution.adapter ?? "CPU"} · ${status.lastExecution.offloaded ? "verified GPU offload" : "CPU, no GPU offload"}${status.lastExecution.offloadEvidence ? ` · ${status.lastExecution.offloadEvidence}` : ""}` : "No execution reported yet."}</p>
      <div aria-label="Resource advice"><h3>Resources and recommendation</h3><p>{advice ? `${advice.resources.cpu.model} · ${advice.resources.cpu.architecture} · ${advice.resources.cpu.usableCores} usable threads. RAM ${bytes(advice.resources.availableRamBytes)} available / ${bytes(advice.resources.totalRamBytes)} total. Free disk ${bytes(advice.resources.freeDiskBytes)}.` : `RAM ${bytes(status?.availableMemoryGb == null ? null : status.availableMemoryGb * 1073741824)} available. Resource details unknown; refresh to retry.`}</p>
        <Dropdown label="Recommendation preference" value={preference} options={[{ value: "balanced", label: "Balanced" }, { value: "quality", label: "Quality" }]} onChange={choice => { setPreference(choice); void refresh(choice); }} />
        <button type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing resources…" : "Refresh resources"}</button>
        <p>{recommended ? `${recommended.provisional ? "Provisional" : "Measured"}: ${recommended.model} · ${backendName(recommended.backend)} · ${recommended.adapter ?? "CPU"}. Confidence: ${recommended.confidence}. ${recommended.reason}` : status?.recommendation ?? "Loading resource advice…"}</p>
        {recommended && <button type="button" disabled={refreshing || !recommended.safeToLoad || !models.some(m => m.id === recommended.model && m.state.status === "installed")} onClick={() => onChange({ ...value, model: recommended.model, device: recommended.backend === "cpu" ? "cpu" : "gpu", backend: recommended.backend === "cpu" ? null : recommended.backend, adapterId: recommended.adapterId })}>Apply recommendation</button>}
        {recommended && !models.some(m => m.id === recommended.model && m.state.status === "installed") && <p>Download {recommended.model} explicitly below before applying advice.</p>}
        {selectedDecision && <p>Selected combination: {({ recommended: "Recommended", usableSlower: "Usable, slower", notRecommended: "Not recommended with current resources", insufficientData: "Insufficient data" })[selectedDecision.status]}. {selectedDecision.reason}</p>}
        <small>Estimates include inference buffers and headroom, not just download size. Shared GPU/RAM is one pool. Quality preference does not guarantee better recognition for every utterance.</small>
      </div>
      <h3>Models</h3><p>Selected: {selectedModel}. Downloading never changes the selection. Select an installed model, then save Settings.</p>
      <div className="dictation-models">{entries.map(entry => {
        const model = models.find(m => m.id === entry.id);
        const state = model?.state;
        const busy = operations.has(entry.id);
        const downloading = state?.status === "installing";
        return <article key={entry.id} className="dictation-model" aria-label={`Model ${entry.id}`}>
          <h4>{entry.id}{entry.id === selectedModel ? " · selected" : ""}</h4><p>Download: {bytes(entry.expectedBytes)} · {entry.languageCoverage}</p><p>{entry.tradeoff}</p>
          <p>Memory estimate: {entry.estimatedPeakBytes.map(m => `${backendName(m.backend)} ${bytes(m.bytes)}${m.measured ? " measured" : " provisional"}`).join(" · ")}</p>
          <p role="status">{state?.status ?? "Checking installation…"}{state?.status === "error" ? `: ${state.message}` : ""}</p>
          {downloading && <progress aria-label={`${entry.id} download`} max={state.total ?? undefined} value={state.received ?? undefined} />}
          <div className="dictation-actions">{state?.status === "installed" ? <><button type="button" disabled={busy || checking} onClick={() => onChange({ ...value, model: entry.id })}>Select {entry.id}</button><button type="button" disabled={busy || checking || (value.enabled && selectedModel === entry.id)} onClick={() => void operation(entry.id, "delete")}>Delete {entry.id}</button></> : downloading || busy ? <button type="button" onClick={() => void cancelDownload(entry.id)}>Cancel {entry.id} download</button> : <button type="button" disabled={!state} onClick={() => void operation(entry.id, state?.status === "error" || state?.status === "cancelled" ? "retry" : "install")}>{state?.status === "error" || state?.status === "cancelled" ? "Retry" : "Download"} {entry.id}</button>}</div>
        </article>;
      })}</div>
      <div><h3>Check performance</h3><p>Runs bundled local speech without the microphone or downloads. Checks the selected combination and at most one smaller installed candidate. Product targets: RTF ≤ 0.5 interactive; 0.5–1 usable with a wait; &gt;1 slow. CUDA/Metal checks need execution instrumentation; use CPU or Vulkan meanwhile.</p>
        <button type="button" disabled={checking || !installed || !benchmarkCandidate || !usable(benchmarkCandidate) || capture.phase !== "idle"} onClick={() => void check()}>Check performance</button>
        {!benchmarkCandidate && <p>Choose CPU or an explicit GPU backend/adapter to check this model.</p>}
        {checking && <><p role="status">{progress ? `${progress.model} · ${backendName(progress.backend)} · ${progress.phase.phase === "measuring" ? `Measuring run ${progress.phase.run} of 3` : progress.phase.phase === "warmup" ? "Warming up" : "Loading model"}` : "Starting performance check…"}</p><button type="button" onClick={() => void cancelCheck()}>Cancel performance check</button></>}
        {results.map(result => <p key={`${result.model}:${result.execution.backend}`}>{result.model} · {backendName(result.execution.backend)} · {result.execution.adapter ?? "CPU"}: cold load {result.measurement.coldLoadMs ?? "Unknown"} ms; median inference {result.medianInferenceMs ?? "Unknown"} ms; RTF {result.medianRtfMilli == null ? "Unknown" : (result.medianRtfMilli / 1000).toFixed(3)}.</p>)}
      </div>
      <p role="status">{notice}</p>{error && <p className="error" role="alert">{error}</p>}
    </div>
  </section>;
}
