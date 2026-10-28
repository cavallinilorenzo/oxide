import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  HistoryIcon,
} from "@primer/octicons-react";
import { terminalAppearance } from "./appearance";

export interface TerminalBlock {
  token: string;
  command: string;
  output: string;
  outputOffset: number;
  cwd: string;
  at: number;
  exitCode: number | null;
  started: boolean;
  ended: boolean;
  truncated: boolean;
}
interface Props {
  block: TerminalBlock;
  active: boolean;
  visible: boolean;
  onInput: (data: string) => void;
  onReady: (rows: number, cols: number) => void;
  onResize: (rows: number, cols: number) => void;
  onScreen: (fullscreen: boolean) => void;
  onReuse: () => void;
}

/** The PTY has a stable viewport. Output can change its clipping, never its live geometry. */
export function TerminalCommandBlock(props: Props) {
  const { block, active, visible, onScreen } = props;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const callbacks = useRef(props);
  const written = useRef(0);
  const fitSurface = useRef<() => void>(() => {});
  const [expanded, setExpanded] = useState(true);
  const [screen, setScreen] = useState(false);
  const [height, setHeight] = useState(16);
  useLayoutEffect(() => {
    callbacks.current = props;
  });
  useEffect(() => {
    const element = host.current!;
    const workspace = element.closest<HTMLElement>(".terminal-workbench")!;
    const toolbar = workspace.querySelector<HTMLElement>(
      ".workbench-terminal-header",
    )!;
    const term = new Terminal({
      fontSize: 13,
      ...terminalAppearance(),
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: 5000,
      convertEol: false,
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    let initialized = false,
      frame = 0,
      viewport = 0,
      cell = 16,
      last = "",
      interactive = false;
    const contentHeight = () =>
      Math.max(
        1,
        Math.min(
          200,
          term.buffer.active.baseY + term.buffer.active.cursorY + 1,
        ),
      ) * cell;
    const fit = () => {
      if (
        !workspace.clientWidth ||
        !workspace.clientHeight ||
        !element.clientWidth
      )
        return;
      viewport = Math.max(80, workspace.clientHeight - toolbar.offsetHeight);
      element.style.height = `${callbacks.current.active ? viewport : contentHeight()}px`;
      addon.fit();
      const screenElement = element.querySelector<HTMLElement>(".xterm-screen");
      if (screenElement && term.rows)
        cell = screenElement.offsetHeight / term.rows || 16;
      setHeight(
        interactive && callbacks.current.active
          ? viewport
          : Math.min(viewport, contentHeight()),
      );
      const dimensions = `${term.rows}:${term.cols}`;
      if (callbacks.current.active && dimensions !== last) {
        last = dimensions;
        if (!initialized) {
          initialized = true;
          callbacks.current.onReady(term.rows, term.cols);
        } else callbacks.current.onResize(term.rows, term.cols);
      }
    };
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fitSurface.current = scheduleFit;
    const appearance = () => {
      const options = terminalAppearance();
      term.options.fontFamily = options.fontFamily;
      term.options.theme = options.theme;
      scheduleFit();
    };
    window.addEventListener("oxide-appearance-changed", appearance);
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(workspace);
    observer.observe(element);
    const markScreen = () => {
      if (!interactive) {
        interactive = true;
        setScreen(true);
        scheduleFit();
      }
      return false;
    };
    const alternate = term.buffer.onBufferChange((buffer) => {
      if (buffer.type === "alternate") markScreen();
    });
    // Cursor-addressed applications also use the normal buffer (readline, Ink, curses variants).
    const cursor = term.parser.registerCsiHandler({ final: "H" }, (params) => {
      if (Number(params[0] ?? 1) > 1) markScreen();
      return false;
    });
    const cursorUp = term.parser.registerCsiHandler({ final: "A" }, markScreen);
    const input = term.onData((data) => {
      if (callbacks.current.active) callbacks.current.onInput(data);
    });
    const parsed = term.onWriteParsed(() => {
      setHeight(
        interactive && callbacks.current.active
          ? viewport
          : Math.min(viewport || 800, contentHeight()),
      );
    });
    scheduleFit();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("oxide-appearance-changed", appearance);
      observer.disconnect();
      input.dispose();
      parsed.dispose();
      alternate.dispose();
      cursor.dispose();
      cursorUp.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, []);
  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const start = Math.max(0, written.current - block.outputOffset);
    const delta = block.output.slice(start);
    if (delta) term.write(delta);
    written.current = block.outputOffset + block.output.length;
  }, [block.output, block.outputOffset]);
  useEffect(() => {
    onScreen(active && screen);
  }, [active, screen, onScreen]);
  useEffect(() => {
    if (!visible || !expanded) return;
    fitSurface.current();
    if (active) terminal.current?.focus();
    else terminal.current?.blur();
  }, [visible, expanded, active]);
  return (
    <section
      className={`terminal-command-block${active ? " running" : ""}${active && screen ? " fullscreen" : ""}`}
      aria-label={`Command: ${block.command}`}
    >
      <header>
        <button
          className="icon-btn sm"
          aria-label={expanded ? "Collapse output" : "Expand output"}
          disabled={active}
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
        <span className={`block-exit${block.exitCode ? " error" : ""}`}>
          {active ? (
            "Running"
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
          onClick={props.onReuse}
        >
          <HistoryIcon size={13} />
        </button>
        <button
          className="icon-btn sm"
          aria-label="Copy command output"
          onClick={() => {
            const t = terminal.current;
            if (t)
              void navigator.clipboard.writeText(
                Array.from(
                  { length: t.buffer.active.length },
                  (_, i) =>
                    t.buffer.active.getLine(i)?.translateToString(true) ?? "",
                )
                  .join("\n")
                  .trimEnd(),
              );
          }}
        >
          <CopyIcon size={13} />
        </button>
      </header>
      {block.truncated && (
        <p className="terminal-truncated">
          Showing the last 256 KiB of output.
        </p>
      )}
      <div
        className="terminal-output-clip"
        hidden={!expanded}
        style={{ height }}
      >
        <div className="terminal-block-output" ref={host} />
      </div>
    </section>
  );
}
