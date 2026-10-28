import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  HistoryIcon,
  PlayIcon,
  SearchIcon,
  SquareFillIcon,
  SyncIcon,
  TerminalIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands } from "./bindings";
import {
  BlockParser,
  commandSuggestions,
  type CommandHistory,
} from "./terminalBlocks";
import { takeFrameBatch } from "./terminalOutput";
import "@xterm/xterm/css/xterm.css";

interface Block {
  token: string;
  command: string;
  output: string;
  cwd: string;
  at: number;
  exitCode: number | null;
  started: boolean;
  ended: boolean;
  truncated: boolean;
}
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
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<CommandHistory[]>(() =>
    loadHistory(contextKey),
  );
  const [search, setSearch] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [cwd, setCwd] = useState(rootPath);
  const [running, setRunning] = useState(false);
  const activeBlock = useRef<string | null>(null);
  const historyCursor = useRef<number | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const runRef = useRef<(command: string) => void>(() => {});

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
              old.map((b) => (b.ended ? b : { ...b, ended: true })),
            );
          }
          if (event.type === "start" && activeBlock.current === event.token) {
            inCommand = true;
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token ? { ...b, started: true } : b,
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
                  truncated: b.truncated || output.length > OUTPUT_LIMIT,
                };
              }),
            );
          }
          if (event.type === "end" && activeBlock.current === event.token) {
            setBlocks((old) =>
              old.map((b) =>
                b.token === event.token
                  ? { ...b, ended: true, exitCode: event.exitCode }
                  : b,
              ),
            );
            if (event.cwd) setCwd(event.cwd);
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
    const token = crypto.randomUUID();
    const block: Block = {
      token,
      command,
      cwd,
      output: "",
      at: Date.now(),
      exitCode: null,
      started: false,
      ended: false,
      truncated: false,
    };
    activeBlock.current = token;
    setRunning(true);
    setInput("");
    setError(null);
    following.current = true;
    setBlocks((old) => [...old.slice(-23), block]);
    setHistory((old) =>
      [...old, { command, at: block.at, exitCode: null }].slice(-300),
    );
    historyCursor.current = null;
    void commands
      .runTerminalBlock(sessionId, command, token)
      .then((result) => {
        if (result.status === "error") throw new Error(result.error.message);
      })
      .catch((e: Error) => {
        setError(e.message);
        setRunning(false);
        activeBlock.current = null;
        setBlocks((old) =>
          old.map((b) => (b.token === token ? { ...b, ended: true } : b)),
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        setSearch("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [visible, running]);
  const suggestions = commandSuggestions(input, history);
  return (
    <main
      className="terminal-workbench"
      aria-label="Terminal workbench"
      hidden={!visible}
    >
      <header className="workbench-terminal-header">
        <TerminalIcon size={16} />
        <strong>{WINDOWS ? "PowerShell" : "Shell"}</strong>
        <span className="mono" title={cwd}>
          {cwd}
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={() => setSearch("")}>
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
        {blocks.length === 0 && (
          <div className="terminal-workbench-welcome">
            <TerminalIcon size={32} />
            <h1>A terminal with room to work.</h1>
            <p>
              Run a command below. Each command keeps its output, exit status
              and working directory together.
            </p>
            <div>
              <kbd>Ctrl+R</kbd> Search history <span>·</span> <kbd>Tab</kbd>{" "}
              Accept suggestion <span>·</span> <kbd>Shift+Enter</kbd> New line
            </div>
          </div>
        )}
        {blocks.map((block) => (
          <CommandBlock
            key={block.token}
            block={block}
            active={!block.ended}
            visible={visible}
            onInput={(data) => void write(data)}
            onResize={(rows, cols) => {
              if (sessionId !== null && !block.ended)
                void commands.resizeTerminal(sessionId, rows, cols);
            }}
            onReuse={() => {
              setInput(block.command);
              composer.current?.focus();
            }}
          />
        ))}
        <div ref={bottom} />
      </div>
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
      <form
        className="terminal-command-composer"
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
        }}
      >
        {!running && suggestions.length > 0 && (
          <div
            className="terminal-suggestions"
            aria-label="Command suggestions"
          >
            {suggestions.map((suggestion, i) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => {
                  setInput(suggestion);
                  composer.current?.focus();
                }}
              >
                <span>{suggestion}</span>
                {i === 0 && <kbd>Tab</kbd>}
              </button>
            ))}
          </div>
        )}
        <div className="terminal-command-entry">
          <ChevronRightIcon size={16} />
          <textarea
            ref={composer}
            aria-label="Terminal command"
            value={input}
            rows={Math.min(5, input.split("\n").length)}
            disabled={running || closed || sessionId === null}
            placeholder={
              running
                ? "Command running — interact with its terminal above"
                : "Type a command…"
            }
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value);
              historyCursor.current = null;
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                run(input);
              }
              if (e.key === "Tab" && suggestions[0]) {
                e.preventDefault();
                setInput(suggestions[0]);
              }
              if (
                e.key === "ArrowUp" &&
                !input.includes("\n") &&
                history.length
              ) {
                e.preventDefault();
                const at = Math.max(
                  0,
                  (historyCursor.current ?? history.length) - 1,
                );
                historyCursor.current = at;
                setInput(history[at]!.command);
              }
              if (e.key === "ArrowDown" && historyCursor.current !== null) {
                e.preventDefault();
                const at = Math.min(history.length, historyCursor.current + 1);
                historyCursor.current = at;
                setInput(history[at]?.command ?? "");
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="icon-btn"
              title="Interrupt (Ctrl+C in the terminal)"
              aria-label="Interrupt command"
              onClick={() => void write("\x03")}
            >
              <SquareFillIcon size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className="icon-btn"
              disabled={!input.trim() || closed || sessionId === null}
              aria-label="Run command"
            >
              <PlayIcon size={16} />
            </button>
          )}
        </div>
        <div className="terminal-command-hint">
          <span>
            {running
              ? "Interactive input is available in the running block."
              : "Enter to run · Shift+Enter for multiple lines"}
          </span>
          <span>
            {blocks.length} {blocks.length === 1 ? "block" : "blocks"}
          </span>
        </div>
      </form>
      {search !== null && (
        <div className="modal-backdrop" onClick={() => setSearch(null)}>
          <div
            className="modal terminal-history"
            role="dialog"
            aria-modal="true"
            aria-label="Command history"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch(null);
            }}
          >
            <header>
              <SearchIcon size={16} />
              <input
                autoFocus
                aria-label="Search command history"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your command history…"
              />
              <button
                className="icon-btn sm"
                aria-label="Close history"
                onClick={() => setSearch(null)}
              >
                <XIcon size={14} />
              </button>
            </header>
            <div>
              {[...history]
                .reverse()
                .filter((h) =>
                  h.command.toLowerCase().includes(search.toLowerCase()),
                )
                .map((h, i) => (
                  <button
                    key={`${h.at}:${i}`}
                    onClick={() => {
                      setInput(h.command);
                      setSearch(null);
                      composer.current?.focus();
                    }}
                  >
                    <code>{h.command}</code>
                    <span className="dim">
                      {h.exitCode === null ? "" : `exit ${h.exitCode}`}
                    </span>
                  </button>
                ))}
              {history.length === 0 && (
                <p className="dim">
                  Commands you run here will appear in your history.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function CommandBlock({
  block,
  active,
  visible,
  onInput,
  onResize,
  onReuse,
}: {
  block: Block;
  active: boolean;
  visible: boolean;
  onInput: (data: string) => void;
  onResize: (rows: number, cols: number) => void;
  onReuse: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const written = useRef("");
  const callbacks = useRef({ onInput, onResize, active });
  const [expanded, setExpanded] = useState(true);
  const [rows, setRows] = useState(4);
  useLayoutEffect(() => {
    callbacks.current = { onInput, onResize, active };
  });
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "Cascadia Code, Consolas, monospace",
      cursorBlink: active,
      cursorInactiveStyle: "none",
      scrollback: 3000,
      convertEol: true,
      theme: {
        background: "#0b0d12",
        foreground: "#d7dbe4",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current);
    terminal.current = term;
    fit.current = addon;
    const resize = () => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      addon.fit();
      if (callbacks.current.active)
        callbacks.current.onResize(term.rows, term.cols);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = term.onData((data) => {
      if (callbacks.current.active) callbacks.current.onInput(data);
    });
    const parsed = term.onWriteParsed(() => {
      if (term.buffer.active.type === "normal")
        setRows(
          Math.min(
            20,
            Math.max(
              2,
              term.buffer.active.baseY + term.buffer.active.cursorY + 1,
            ),
          ),
        );
      else setRows(24);
    });
    return () => {
      observer.disconnect();
      input.dispose();
      parsed.dispose();
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
    // One emulator per command block; live callbacks come through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    if (!block.output.startsWith(written.current)) {
      term.reset();
      written.current = "";
    }
    const delta = block.output.slice(written.current.length);
    if (delta) term.write(delta);
    written.current = block.output;
  }, [block.output]);
  useEffect(() => {
    if (!visible || !expanded) return;
    const frame = requestAnimationFrame(() => {
      fit.current?.fit();
      const t = terminal.current;
      if (active && t) {
        callbacks.current.onResize(t.rows, t.cols);
        t.focus();
      } else t?.blur();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, expanded, active, rows]);
  return (
    <section
      className={`terminal-command-block${active ? " running" : ""}`}
      aria-label={`Command: ${block.command}`}
    >
      <header>
        <button
          className="icon-btn sm"
          aria-label={expanded ? "Collapse output" : "Expand output"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <ChevronDownIcon size={14} />
          ) : (
            <ChevronRightIcon size={14} />
          )}
        </button>
        <code>{block.command}</code>
        <span className="grow" />
        <span
          className={`block-exit${block.exitCode && block.exitCode !== 0 ? " error" : ""}`}
        >
          {active ? (
            <>
              <SyncIcon className="spin" size={12} /> Running
            </>
          ) : block.exitCode === 0 ? (
            <>
              <CheckIcon size={12} /> Done
            </>
          ) : block.exitCode === null ? (
            "Shell exited"
          ) : (
            `Exit ${block.exitCode}`
          )}
        </span>
        <button
          className="icon-btn sm"
          aria-label="Reuse command"
          title="Reuse command"
          onClick={onReuse}
        >
          <HistoryIcon size={13} />
        </button>
        <button
          className="icon-btn sm"
          aria-label="Copy command output"
          onClick={() => {
            const t = terminal.current;
            if (!t) return;
            const lines = Array.from(
              { length: t.buffer.active.length },
              (_, n) =>
                t.buffer.active.getLine(n)?.translateToString(true) ?? "",
            );
            void navigator.clipboard.writeText(lines.join("\n").trimEnd());
          }}
        >
          <CopyIcon size={13} />
        </button>
      </header>
      <div className="terminal-block-meta">
        <span title={block.cwd}>{block.cwd}</span>
        <time dateTime={new Date(block.at).toISOString()}>
          {new Date(block.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
      {block.truncated && (
        <p className="terminal-truncated">
          Showing the last 256 KiB of output.
        </p>
      )}
      <div
        className="terminal-block-output"
        hidden={!expanded}
        style={{ height: `${active ? Math.max(rows, 12) : rows}lh` }}
        ref={host}
      />
    </section>
  );
}
