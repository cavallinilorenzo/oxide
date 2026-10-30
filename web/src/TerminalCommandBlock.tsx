import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalAppearance } from "./appearance";

export interface TerminalBlock {
  token: string;
  command: string;
  output: string;
  outputOffset: number;
  /** Where the command ran. Kept for the record; the Terminal header shows the live cwd. */
  cwd: string;
  at: number;
  completedAt?: number;
  exitCode: number | null;
  started: boolean;
  ended: boolean;
  truncated: boolean;
}
interface Props {
  onPasteReady?: (paste: ((text: string) => void) | null) => void;
  block: TerminalBlock;
  active: boolean;
  visible: boolean;
  onInput: (data: string) => void;
  onReady: (rows: number, cols: number) => void;
  onResize: (rows: number, cols: number) => void;
  onScreen: (fullscreen: boolean) => void;
}

/** The PTY has a stable viewport. Output can change its clipping, never its live geometry. */
export function TerminalCommandBlock(props: Props) {
  const { block, active, visible, onScreen, onPasteReady } = props;
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const callbacks = useRef(props);
  const written = useRef(0);
  const fitSurface = useRef<() => void>(() => {});
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
      ...terminalAppearance(),
      cursorBlink: true,
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
      term.options.fontSize = options.fontSize;
      term.options.fontWeight = options.fontWeight;
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
    if (!active || !onPasteReady) return;
    const insert = (text: string) => { terminal.current?.paste(text); terminal.current?.focus(); };
    onPasteReady(insert);
    return () => onPasteReady(null);
  }, [active, onPasteReady]);
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
    if (!visible) return;
    fitSurface.current();
    if (active) terminal.current?.focus();
    else terminal.current?.blur();
  }, [visible, active]);
  return (
    <section
      className={`terminal-command-block${active ? " running" : ""}${active && screen ? " fullscreen" : ""}`}
      aria-label={`Command: ${block.command}`}
    >
      <header>
        <code>{block.command}</code>
        <span className="grow" />
        <BlockStatus block={block} running={active} />
      </header>
      {block.truncated && (
        <p className="terminal-truncated">
          Showing the last 256 KiB of output.
        </p>
      )}
      <div className="terminal-output-clip" style={{ height }}>
        <div className="terminal-block-output" ref={host} />
      </div>
    </section>
  );
}

/** One status at the right of the header: a spinner while running, then how long it took. */
function BlockStatus({ block, running }: { block: TerminalBlock; running: boolean }) {
  if (running)
    return (
      <span className="terminal-block-status" role="status">
        <span className="terminal-block-spinner" aria-hidden="true" />
        <span className="sr-only">Running</span>
      </span>
    );
  const duration = formatDuration(Math.max(0, (block.completedAt ?? block.at) - block.at));
  const [shown, said] =
    block.exitCode === 0
      ? [duration, `Command duration: ${duration}`]
      : block.exitCode === null
        ? [`shell exited · ${duration}`, `Shell exited after ${duration}`]
        : [`exit ${block.exitCode} · ${duration}`, `Exit ${block.exitCode} after ${duration}`];
  return (
    <span className={`terminal-block-status${block.exitCode === 0 ? "" : " error"}`} role="status">
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{said}</span>
    </span>
  );
}

/** Rounds to the shown precision before picking the unit, so 59.999 s reads 1m 0.0s, not 60.00 s. */
export function formatDuration(milliseconds: number): string {
  const ms = Math.round(milliseconds);
  if (ms < 1000) return `${ms} ms`;
  const hundredths = Math.round(milliseconds / 10);
  if (hundredths < 6000) return `${(hundredths / 100).toFixed(2)} s`;
  const tenths = Math.round(milliseconds / 100);
  return `${Math.floor(tenths / 600)}m ${((tenths % 600) / 10).toFixed(1)}s`;
}
