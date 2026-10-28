import { useState } from "react";
import {
  acceleratorFromEvent,
  DEFAULT_SHORTCUTS,
  formatAccelerator,
  SHORTCUT_ACTIONS,
  type ShortcutAction,
  type Shortcuts,
} from "./shortcuts";

/** The action that already uses `accelerator`, other than `except`. */
function takenBy(shortcuts: Shortcuts, accelerator: string, except: ShortcutAction) {
  return SHORTCUT_ACTIONS.find(
    ({ action }) => action !== except && shortcuts[action].toLowerCase() === accelerator.toLowerCase(),
  );
}

/** Settings' Keyboard shortcuts: click a shortcut, press the new keys; Esc cancels. */
export function ShortcutsSettings({ shortcuts, onChange, errorsFor }: {
  shortcuts: Shortcuts;
  onChange: (next: Shortcuts) => void;
  errorsFor: (action: ShortcutAction) => string[];
}) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [conflict, setConflict] = useState<{ action: ShortcutAction; message: string } | null>(null);

  const record = (action: ShortcutAction, e: React.KeyboardEvent) => {
    // Nothing else may react to the keys being recorded.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(null);
      setConflict(null);
      return;
    }
    const accelerator = acceleratorFromEvent(e.nativeEvent);
    if (!accelerator) {
      if (!["Meta", "Control", "Alt", "Shift"].includes(e.key)) {
        setConflict({ action, message: "Include ⌘ (Ctrl on Windows and Linux), then a letter, digit, symbol, arrow or F-key." });
      }
      return;
    }
    const other = takenBy(shortcuts, accelerator, action);
    if (other) {
      setConflict({ action, message: `${formatAccelerator(accelerator)} is already used by ${other.label}.` });
      return;
    }
    onChange({ ...shortcuts, [action]: accelerator });
    setRecording(null);
    setConflict(null);
  };

  const groups = [...new Set(SHORTCUT_ACTIONS.map(({ group }) => group))];
  return (
    <section className="settings-section" aria-labelledby="settings-shortcuts">
      <header className="settings-section-header">
        <h2 id="settings-shortcuts">Keyboard shortcuts</h2>
        <p>Click a shortcut, then press the keys you want. Press Esc to cancel.</p>
      </header>
      <div className="settings-card">
        {groups.map((group) => (
          <div key={group} className="shortcut-group" role="group" aria-label={group}>
            <h3 className="shortcut-group-title">{group}</h3>
            {SHORTCUT_ACTIONS.filter((item) => item.group === group).map(({ action, label }) => {
              const isRecording = recording === action;
              const problems = [...errorsFor(action), ...(conflict?.action === action ? [conflict.message] : [])];
              return (
                <div className="shortcut-row" key={action}>
                  <span className="shortcut-label">{label}</span>
                  <button
                    type="button"
                    className="shortcut-key"
                    aria-label={`${label} shortcut`}
                    aria-pressed={isRecording}
                    onClick={() => { setRecording(action); setConflict(null); }}
                    onKeyDown={isRecording ? (e) => record(action, e) : undefined}
                    onBlur={() => { if (isRecording) { setRecording(null); setConflict(null); } }}
                  >
                    {isRecording ? "Press keys…" : <kbd>{formatAccelerator(shortcuts[action])}</kbd>}
                  </button>
                  <button
                    type="button"
                    className="shortcut-reset"
                    aria-label={`Reset ${label} shortcut`}
                    disabled={shortcuts[action] === DEFAULT_SHORTCUTS[action]}
                    onClick={() => onChange({ ...shortcuts, [action]: DEFAULT_SHORTCUTS[action] })}
                  >
                    Reset
                  </button>
                  {problems.map((message) => (
                    <p key={message} className="error shortcut-error" role="alert">{message}</p>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
        <div className="shortcut-reset-all">
          <button type="button" onClick={() => onChange({ ...DEFAULT_SHORTCUTS })}
            disabled={SHORTCUT_ACTIONS.every(({ action }) => shortcuts[action] === DEFAULT_SHORTCUTS[action])}>
            Reset all shortcuts
          </button>
        </div>
      </div>
    </section>
  );
}
