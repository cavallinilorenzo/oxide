import { useEffect, useRef, type KeyboardEvent } from "react";
import { PlusIcon, TerminalIcon, XIcon } from "@primer/octicons-react";
import { TerminalWorkbench } from "./TerminalWorkbench";
import { isMismatched, type ProjectTerminals, type TerminalCheckout, type TerminalTab } from "./terminalTabs";
import { terminalPath } from "./terminalPaths";

interface Props {
  projectId: number;
  terminals: ProjectTerminals;
  /** The selected Thread's checkout, or `null` when none is selected. */
  checkout: TerminalCheckout | null;
  /** Whether the Terminal Surface is showing; hidden tabs keep running. */
  visible: boolean;
  queuedCommand: { id: number; command: string } | null;
  onCommandConsumed: () => void;
  onOpenTab: () => void;
  onSelectTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
  onRunningChange: (tabId: number, command: string | null) => void;
}

const folderName = (path: string) => {
  const clean = terminalPath(path).replace(/[\\/]+$/, "");
  return clean.split(/[\\/]/).pop() || clean;
};

const NO_CHECKOUT = "Select a Thread to open a terminal in its checkout.";

/** One Project's shells. Tabs outlive Thread selection, Surface changes and maximizing. */
export function TerminalSurface({
  projectId, terminals, checkout, visible, queuedCommand, onCommandConsumed, onOpenTab, onSelectTab, onCloseTab, onRunningChange,
}: Props) {
  const strip = useRef<HTMLDivElement>(null);
  const { tabs, selectedId } = terminals;

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedId, tabs.length]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === selectedId);
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -index : event.key === "End" ? tabs.length - 1 - index : null;
    if (move === null || tabs.length === 0) return;
    event.preventDefault();
    const next = tabs[(index + move + tabs.length) % tabs.length];
    onSelectTab(next.id);
    requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus());
  }

  return (
    <div className="terminal-surface" hidden={!visible} aria-label="Terminal tabs">
      <div className="terminal-tabbar">
        <div className="terminal-tab-strip" role="tablist" aria-label="Project terminals" ref={strip} onKeyDown={onKeyDown}>
          {tabs.map((tab) => <TabButton key={tab.id} tab={tab} selected={tab.id === selectedId}
            mismatched={isMismatched(tab, checkout)} onSelect={onSelectTab} onClose={onCloseTab} />)}
        </div>
        <button className="icon-btn sm" aria-label="New terminal tab" disabled={!checkout}
          title={checkout ? "New terminal in the selected Thread’s checkout" : NO_CHECKOUT} onClick={onOpenTab}>
          <PlusIcon size={14} />
        </button>
      </div>
      {!checkout && tabs.length > 0 && <p className="surface-note" role="status">{NO_CHECKOUT}</p>}
      {tabs.length === 0 && (
        <section className="empty-state surface-empty">
          <TerminalIcon size={24} />
          <p>{checkout ? "Open a terminal in the selected Thread’s checkout." : NO_CHECKOUT}</p>
          <button className="btn" disabled={!checkout} onClick={onOpenTab}>Open terminal</button>
        </section>
      )}
      {tabs.map((tab) => (
        <div key={tab.id} className="terminal-tab-panel" role="tabpanel" aria-label={`Terminal ${folderName(tab.rootPath)}`} hidden={tab.id !== selectedId || !visible}>
          <TerminalWorkbench
            projectId={projectId}
            threadId={tab.threadId}
            rootPath={tab.rootPath}
            contextKey={tab.key}
            visible={visible && tab.id === selectedId}
            queuedCommand={tab.id === selectedId ? queuedCommand : null}
            onCommandConsumed={onCommandConsumed}
            onRunningChange={(command) => onRunningChange(tab.id, command)}
          />
        </div>
      ))}
    </div>
  );
}

function TabButton({ tab, selected, mismatched, onSelect, onClose }: {
  tab: TerminalTab; selected: boolean; mismatched: boolean; onSelect: (id: number) => void; onClose: (id: number) => void;
}) {
  const name = folderName(tab.rootPath);
  const title = `${tab.rootPath}${tab.running ? ` — running ${tab.running}` : ""}${mismatched ? " — not the selected Thread’s checkout" : ""}`;
  return (
    <div className={`terminal-tab${selected ? " active" : ""}`} data-mismatch={mismatched || undefined}>
      <button role="tab" data-tab-id={tab.id} aria-selected={selected} tabIndex={selected ? 0 : -1} title={title} onClick={() => onSelect(tab.id)}>
        <span className="terminal-tab-name">{name}</span>
        {tab.running && <span className="terminal-tab-running" aria-label="Command running" />}
        {mismatched && <span className="terminal-tab-mismatch">other checkout</span>}
      </button>
      <button className="icon-btn sm" aria-label={`Close terminal ${name}`} title={`Close terminal ${name}`} onClick={() => onClose(tab.id)}>
        <XIcon size={12} />
      </button>
    </div>
  );
}
