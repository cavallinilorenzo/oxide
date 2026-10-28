import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "./bindings";
import { quitPrompt } from "./quitPrompt";
import { saveAllEditors } from "./editorSaves";

/** Asks before ⌘Q interrupts running Threads; the shell sends `quit-requested` with how many. */
export function QuitDialog() {
  const [running, setRunning] = useState<number | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [unsaved, setUnsaved] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    const unlisten = listen<number>("editor-quit-requested", (event) => { setUnsaved(event.payload); setSaveError(null); });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<number>("quit-requested", (event) => {
      setDontAskAgain(false);
      setRunning(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (running === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRunning(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running]);

  if (unsaved !== null) return <div className="modal-backdrop"><div className="modal" role="alertdialog" aria-label="Unsaved editor changes"><h2>Save your files before quitting?</h2><p>{unsaved} editor {unsaved === 1 ? "has" : "have"} unsaved changes. Quitting also stops running Threads and terminals.</p>{saveError && <p role="alert" className="error">{saveError}</p>}<div className="modal-actions"><button autoFocus disabled={saving} onClick={() => setUnsaved(null)}>Cancel</button><button disabled={saving} onClick={() => void commands.confirmQuit(false)}>Discard &amp; quit</button><button className="primary" disabled={saving} onClick={() => { setSaving(true); void saveAllEditors().then(async (saved) => { if (saved) await commands.confirmQuit(false); else setSaveError("Some files could not be saved. Cancel to review the editor errors."); }).catch((e: Error) => setSaveError(e.message)).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save all & quit"}</button></div></div></div>;
  if (running === null) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="quit-title">
        <h2 id="quit-title">{quitPrompt(running)}</h2>
        <label>
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
          />{" "}
          Don't ask again
        </label>
        <div className="modal-actions">
          <button autoFocus onClick={() => setRunning(null)}>
            Cancel
          </button>
          <button onClick={() => void commands.confirmQuit(dontAskAgain)}>Quit</button>
        </div>
      </div>
    </div>
  );
}
