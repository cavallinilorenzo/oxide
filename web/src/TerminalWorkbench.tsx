import { dictationLine, useDictationTarget } from "./dictation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  HistoryIcon,
  SyncIcon,
  TerminalIcon,
  XIcon,
  SquareFillIcon,
} from "@primer/octicons-react";
import {
  TerminalCommandBlock,
  type TerminalBlock as Block,
} from "./TerminalCommandBlock";
import { TerminalInput, type TerminalInputHandle } from "./TerminalInput";
import { terminalPath } from "./terminalPaths";
import { commands } from "./bindings";
import { BlockParser, type CommandHistory } from "./terminalBlocks";
import { takeFrameBatch } from "./terminalOutput";
import { useTerminalTransfer } from "./useTerminalTransfer";
import "@xterm/xterm/css/xterm.css";

interface Props {
  projectId: number;
  threadId: number | null;
  rootPath: string;
  contextKey: string;
  visible: boolean;
  queuedCommand: { id: number; command: string } | null;
  onCommandConsumed: () => void;
}
const WINDOWS = /Windows/i.test(navigator.userAgent);
const OUTPUT_LIMIT = 256 * 1024;

function loadHistory(key: string): CommandHistory[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`oxide:terminal-history:${key}`) ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter(
            (v): v is CommandHistory =>
              typeof v?.command === "string" && typeof v?.at === "number",
          )
          .slice(-300)
      : [];
  } catch {
    return [];
  }
}

export function TerminalWorkbench({
  projectId,
  threadId,
  rootPath,
  contextKey,
  visible,
  queuedCommand,
  onCommandConsumed,
}: Props) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [history, setHistory] = useState<CommandHistory[]>(() =>
    loadHistory(contextKey),
  );
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [cwd, setCwd] = useState(terminalPath(rootPath));
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const launched = useRef(new Set<string>());
  const [running, setRunning] = useState(false);
  const activeBlock = useRef<string | null>(null);
  const composer = useRef<TerminalInputHandle>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const runRef = useRef<(command: string) => void>(() => {});
  const host = useRef<HTMLElement>(null);
  const pasteActive = useRef<((text: string) => void) | null>(null);
  const onPasteReady = useCallback((paste: ((text: string) => void) | null) => { pasteActive.current = paste; }, []);
  const transfer = useTerminalTransfer(host, visible && !closed && sessionId !== null, (text) => {
    if (running) pasteActive.current?.(text);
    else composer.current?.insert(text);
  });

  useDictationTarget(host, (text) => {
    const line = dictationLine(text);
    if (running) pasteActive.current?.(line); else composer.current?.insert(line);
  }, visible && !closed && sessionId !== null);

  useEffect(() => {
    let active = true;
    let id: number | null = null;
    let frame: number | null = null;
    const pending: Uint8Array[] = [];
    const decoder = new TextDecoder();
    const parser = new BlockParser();
    let inCommand = false;
    let probeBuffer = "";
    const pendingReplies: string[] = [];
    const reply = (text: string) => {
      if (id === null) pendingReplies.push(text);
      else void commands.writeTerminal(id, [...new TextEncoder().encode(text)]);
    };
    const channel = new Channel<number[]>();
    const flush = () => {
      frame = null;
      const events = parser.push(
        decoder.decode(takeFrameBatch(pending), { stream: true }),
      );
      if (active) {
        for (const event of events) {
          if (event.type === "output" && !inCommand) {
            probeBuffer += event.text;
            while (probeBuffer.includes("\x1b[6n")) {
              reply("\x1b[1;1R");
              probeBuffer = probeBuffer.slice(
                probeBuffer.indexOf("\x1b[6n") + 4,
              );
            }
            probeBuffer = probeBuffer.slice(-16);
          }
          if (event.type === "closed") {
            setClosed(true);
            setRunning(false);
            activeBlock.current = null;
            setBlocks((old) =>
              old.map((b) => (b.ended ? b : { ...b, ended: true, completedAt: Date.now() })),
            );
          }
          if (event.type === "start" && activeBlock.current === event.token) {
            inCommand = true;
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token ? { ...b, started: true, at: Date.now() } : b,
              ),
            );
          }
          if (event.type === "output" && activeBlock.current) {
            const token = activeBlock.current;
            setBlocks((old) =>
              old.map((b) => {
                if (b.token !== token || !b.started || b.ended) return b;
                const output = b.output + event.text;
                return {
                  ...b,
                  output: output.slice(-OUTPUT_LIMIT),
                  outputOffset:
                    b.outputOffset + Math.max(0, output.length - OUTPUT_LIMIT),
                  truncated: b.truncated || output.length > OUTPUT_LIMIT,
                };
              }),
            );
          }
          if (event.type === "end" && activeBlock.current === event.token) {
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token
                  ? { ...b, ended: true, exitCode: event.exitCode, completedAt: Date.now() }
                  : b,
              ),
            );
            if (event.cwd) setCwd(terminalPath(event.cwd));
            setHistory((old) =>
              old.map((h, index) =>
                index === old.length - 1
                  ? { ...h, exitCode: event.exitCode }
                  : h,
              ),
            );
            activeBlock.current = null;
            setRunning(false);
            inCommand = false;
            if (visible) requestAnimationFrame(() => composer.current?.focus());
          }
        }
      }
      if (pending.length) frame = requestAnimationFrame(flush);
    };
    channel.onmessage = (bytes) => {
      pending.push(new Uint8Array(bytes));
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    void commands
      .startBlockTerminal(projectId, threadId, channel)
      .then(async (result) => {
        if (result.status === "error") throw new Error(result.error.message);
        id = result.data.id;
        if (!active) {
          await commands.closeTerminal(id);
          return;
        }
        setSessionId(id);
        setClosed(false);
        setError(null);
        for (const text of pendingReplies) reply(text);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      if (frame !== null) cancelAnimationFrame(frame);
      if (id !== null) void commands.closeTerminal(id);
    };
    // A mode switch must never start a new shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, threadId, generation]);

  useEffect(() => {
    try {
      localStorage.setItem(
        `oxide:terminal-history:${contextKey}`,
        JSON.stringify(history),
      );
    } catch {
      /* History still works for this session. */
    }
  }, [history, contextKey]);
  useEffect(() => {
    if (visible && following.current)
      bottom.current?.scrollIntoView({ block: "nearest" });
  }, [blocks, visible]);

  const write = useCallback(
    async (text: string) => {
      if (sessionId === null) return;
      try {
        const result = await commands.writeTerminal(sessionId, [
          ...new TextEncoder().encode(text),
        ]);
        if (result.status === "error") setError(result.error.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId],
  );
  function run(command: string) {
    if (
      !command.trim() ||
      running ||
      closed ||
      sessionId === null ||
      activeBlock.current
    )
      return;
    if (/^(clear|cls|clear-host)\s*$/i.test(command.trim())) {
      setBlocks([]);
      launched.current.clear();
      setFullscreen(null);
      composer.current?.clear();
      setError(null);
      return;
    }
    const token = crypto.randomUUID();
    setFullscreen(null);
    const block: Block = {
      token,
      command,
      cwd,
      output: "",
      outputOffset: 0,
      at: Date.now(),
      exitCode: null,
      started: false,
      ended: false,
      truncated: false,
    };
    activeBlock.current = token;
    setRunning(true);
    composer.current?.clear();
    setError(null);
    following.current = true;
    setBlocks((old) => [...old.slice(-23), block]);
    setHistory((old) =>
      [...old, { command, at: block.at, exitCode: null }].slice(-300),
    );
  }
  function launch(block: Block, rows: number, cols: number) {
    if (sessionId === null || launched.current.has(block.token)) return;
    launched.current.add(block.token);
    void (async () => {
      const resized = await commands.resizeTerminal(sessionId, rows, cols);
      if (resized.status === "error") throw new Error(resized.error.message);
      const result = await commands.runTerminalBlock(
        sessionId,
        block.command,
        block.token,
      );
      if (result.status === "error") throw new Error(result.error.message);
    })().catch((error: Error) => {
      setError(error.message);
      setRunning(false);
      activeBlock.current = null;
      setBlocks((old) =>
        old.map((b) => (b.token === block.token ? { ...b, ended: true, completedAt: Date.now() } : b)),
      );
    });
  }

  useLayoutEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!visible || !queuedCommand || running || sessionId === null || closed)
      return;
    runRef.current(queuedCommand.command);
    onCommandConsumed();
  }, [visible, queuedCommand, running, sessionId, closed, onCommandConsumed]);
  useEffect(() => {
    if (!visible) return;
    if (!running) composer.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target)) return;
      if (!running && event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        runRef.current("clear");
      }
      if (
        !running &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        composer.current?.history();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [visible, running]);
  return (
    <main
      className="terminal-workbench"
      ref={host}
      data-dragging={transfer.dragging || undefined}
      aria-busy={transfer.busy || undefined}
      aria-label="Terminal workbench"
      hidden={!visible}
      data-fullscreen={running && fullscreen !== null ? "true" : undefined}
    >
      <header className="workbench-terminal-header">
        <TerminalIcon size={16} />
        <strong>{WINDOWS ? "PowerShell" : "Shell"}</strong>
        <span className="mono" title={cwd}>
          {cwd}
        </span>
        <span className="grow" />
        <button className="btn sm" disabled={running || sessionId === null || closed} title="Clear terminal (Ctrl+L)" onClick={() => run("clear")}>Clear</button>
        <button
          className="btn sm"
          disabled={running}
          onClick={() => composer.current?.history()}
        >
          <HistoryIcon size={14} /> History
        </button>
        <button
          className="icon-btn sm"
          title="Restart shell"
          aria-label="Restart shell"
          disabled={running}
          onClick={() => {
            setSessionId(null);
            setGeneration((n) => n + 1);
          }}
        >
          <SyncIcon size={14} />
        </button>
      </header>
      <div
        className="terminal-block-scroll"
        ref={scroll}
        onScroll={() => {
          const el = scroll.current;
          following.current =
            !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {blocks.map((block) => (
          <TerminalCommandBlock
            onPasteReady={onPasteReady}
            key={block.token}
            block={block}
            active={!block.ended}
            visible={visible}
            onInput={(data) => void write(data)}
            onReady={(rows, cols) => launch(block, rows, cols)}
            onScreen={(screen) =>
              setFullscreen((old) =>
                screen ? block.token : old === block.token ? null : old,
              )
            }
            onResize={(rows, cols) => {
              if (sessionId !== null && !block.ended)
                void commands.resizeTerminal(sessionId, rows, cols);
            }}
            onReuse={() => {
              composer.current?.setCommand(block.command);
              composer.current?.focus();
            }}
          />
        ))}
        <div ref={bottom} />
      </div>
      {transfer.dragging && <div className="terminal-drop-hint">Drop files to insert their paths</div>}
      {transfer.busy && <div className="surface-note" role="status">Saving pasted file…</div>}
      {transfer.error && <div className="editor-error" role="alert">{transfer.error}</div>}
      {error && (
        <div className="editor-error" role="alert">
          {error}
          <button
            className="icon-btn sm"
            aria-label="Dismiss terminal error"
            onClick={() => setError(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
      {closed && (
        <div className="terminal-shell-closed" role="status">
          Shell exited.{" "}
          <button
            className="btn sm"
            onClick={() => {
              setSessionId(null);
              setGeneration((n) => n + 1);
            }}
          >
            Start a new shell
          </button>
        </div>
      )}
      {running ? (
        !fullscreen && (
          <button
            className="terminal-interrupt"
            onClick={() => void write("\x03")}
            aria-label="Interrupt command"
          >
            <SquareFillIcon size={12} /> Interrupt <kbd>Ctrl+C</kbd>
          </button>
        )
      ) : (
        <TerminalInput
          ref={composer}
          history={history}
          sessionId={sessionId}
          cwd={cwd}
          disabled={closed || sessionId === null}
          visible={visible}
          onRun={run}
        />
      )}
    </main>
  );
}
