import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands } from "./bindings";
import { quitPrompt } from "./quitPrompt";

/** Asks before ⌘Q interrupts running Threads; the shell sends `quit-requested` with how many. */
export function QuitDialog() {
  const [running, setRunning] = useState<number | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

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
