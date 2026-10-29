import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { CheckCircleIcon, DownloadIcon, SyncIcon } from "@primer/octicons-react";
import { commands, type UpdateStatus } from "./bindings";

export function UpdatesSettings() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const section = useRef<HTMLElement>(null);
  const revealResult = useRef(false);
  useLayoutEffect(() => {
    if (status?.version && revealResult.current) {
      section.current?.scrollIntoView?.({ block: "end" });
      revealResult.current = false;
    }
  }, [status?.version]);
  const busy = requesting || status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing";
  useEffect(() => {
    let active = true;
    const refresh = () => void commands.appUpdateStatus().then((value) => { if (active) setStatus(value); }).catch((e) => { if (active) setError(String(e)); });
    refresh();
    // Native operations survive closing Settings; reconnect to their progress.
    const timer = busy ? window.setInterval(refresh, 1000) : undefined;
    return () => { active = false; window.clearInterval(timer); };
  }, [busy]);
  const check = async () => {
    revealResult.current = true;
    setRequesting(true);
    setError(null);
    try {
      const result = await commands.checkAppUpdate();
      if (result.status === "error") throw new Error(result.error.message);
      setStatus(result.data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRequesting(false); }
  };
  const install = async () => {
    setRequesting(true);
    setError(null);
    try {
      const progress = new Channel<UpdateStatus>();
      progress.onmessage = setStatus;
      const result = await commands.installAppUpdate(progress);
      if (result.status === "error") throw new Error(result.error.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((value) => value ? { ...value, phase: "available" } : value);
    } finally { setRequesting(false); }
  };
  const downloading = status?.phase === "downloading";
  const installing = status?.phase === "installing";
  const percent = status?.total ? Math.min(100, Math.round((status.downloaded ?? 0) / status.total * 100)) : undefined;
  return <section ref={section} className="settings-section" aria-labelledby="settings-updates">
    <header className="settings-section-header"><h2 id="settings-updates">Updates</h2><p>Keep Oxide up to date with the latest published release.</p></header>
    <div className="settings-card updates-settings">
      <div className="updates-summary"><div><h3>Oxide</h3><p className="settings-note">{status ? `Version ${status.currentVersion}` : "Reading installed version…"}</p></div>
        <button className="btn" disabled={busy} onClick={() => void check()}><SyncIcon size={14} />{busy && !downloading && !installing ? "Checking…" : "Check for updates"}</button>
      </div>
      {status?.phase === "upToDate" && !error && <p className="updates-current" role="status"><CheckCircleIcon size={16} />You’re up to date.</p>}
      {status?.version && <div className="updates-available"><h3>Oxide {status.version} is available</h3>
        {status.notes && <p className="updates-notes">{status.notes}</p>}
        <p className="settings-note">The download is verified before installation. Oxide will restart to finish updating. Save your work first.</p>
        <button className="btn primary" disabled={busy} onClick={() => void install()}><DownloadIcon size={14} />{installing ? "Installing…" : downloading ? "Downloading…" : "Download and install"}</button>
      </div>}
      {(downloading || installing) && <div role="status" className="updates-progress"><progress aria-label="Update download progress" max={100} value={downloading ? percent : undefined} /><span>{installing ? "Installing update…" : percent === undefined ? "Downloading update…" : `Downloading update… ${percent}%`}</span></div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  </section>;
}
