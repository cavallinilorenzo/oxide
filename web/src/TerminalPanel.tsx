import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { commands } from "./bindings";
import { takeFrameBatch } from "./terminalOutput";
import "@xterm/xterm/css/xterm.css";

interface TerminalPanelProps {
  projectId: number;
  threadId: number | null;
  contextKey: string;
  visible: boolean;
}

export function TerminalPanel({ projectId, threadId, contextKey, visible }: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      scrollback: 10_000,
      convertEol: true,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    let active = true;
    let terminalId: number | null = null;
    let frame: number | null = null;
    const pending: Uint8Array[] = [];
    const decoder = new TextDecoder();
    const channel = new Channel<number[]>();
    channel.onmessage = (bytes) => {
      pending.push(new Uint8Array(bytes));
      if (frame === null) frame = requestAnimationFrame(flushOutput);
    };

    function flushOutput() {
      frame = null;
      const batch = takeFrameBatch(pending);
      if (batch.length) terminal.write(decoder.decode(batch, { stream: true }));
      if (pending.length) frame = requestAnimationFrame(flushOutput);
    }

    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
        if (terminalId !== null) void commands.resizeTerminal(terminalId, terminal.rows, terminal.cols);
      } catch {
        // FitAddon can reject a transient zero-sized layout during window resize.
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const dataSubscription = terminal.onData((data) => {
      if (terminalId !== null) void commands.writeTerminal(terminalId, [...new TextEncoder().encode(data)]);
    });

    setError(null);
    void (async () => {
      try {
        const result = await commands.startTerminal(projectId, threadId, channel);
        if (result.status === "error") throw new Error(result.error.message);
        terminalId = result.data.id;
        if (!active) {
          await commands.closeTerminal(terminalId);
          return;
        }
        terminal.clear();
        resize();
        terminal.focus();
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      active = false;
      observer.disconnect();
      dataSubscription.dispose();
      if (frame !== null) cancelAnimationFrame(frame);
      if (terminalId !== null) void commands.closeTerminal(terminalId);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [projectId, threadId, contextKey]);

  useEffect(() => {
    if (visible && terminalRef.current) {
      requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        if (!terminal || !hostRef.current?.clientWidth) return;
        try {
          fitRef.current?.fit();
        } catch {
          // The panel may still be in a zero-sized layout transition.
        }
        terminal.focus();
      });
    }
  }, [visible]);

  return (
    <section className={`terminal${visible ? "" : " terminal-hidden"}`} aria-label="Terminal" aria-hidden={!visible}>
      <div className="terminal-toolbar">
        <span>Terminal</span>
        {error && <span className="terminal-error">{error}</span>}
      </div>
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}
