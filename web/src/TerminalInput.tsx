import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  HistoryIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands, type TerminalCompletion } from "./bindings";
import type { CommandHistory } from "./terminalBlocks";
import { historyMatches } from "./terminalBlocks";

export interface TerminalInputHandle {
  focus: () => void;
  setCommand: (command: string) => void;
  clear: () => void;
  history: () => void;
  insert: (text: string) => void;
}
interface Props {
  ref: Ref<TerminalInputHandle>;
  history: CommandHistory[];
  sessionId: number | null;
  /** Where shell completion resolves paths. */
  cwd: string;
  disabled: boolean;
  visible: boolean;
  /** No Command has run yet: show the shortcut hint. */
  fresh: boolean;
  onRun: (command: string) => void;
}
export function TerminalInput({
  ref,
  history,
  sessionId,
  cwd,
  disabled,
  visible,
  fresh,
  onRun,
}: Props) {
  const [input, setInput] = useState("");
  const [selection, setSelection] = useState(0);
  const [menu, setMenu] = useState<"history" | "completion" | null>(null);
  const [query, setQuery] = useState("");
  const [prefixSearch, setPrefixSearch] = useState(false);
  const [index, setIndex] = useState(0);
  const [completion, setCompletion] = useState<TerminalCompletion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const base = useRef({ line: "", cursor: 0 });
  const id = useId();
  const past = [...history]
    .reverse()
    .filter(
      (entry, i, all) =>
        all.findIndex((other) => other.command === entry.command) === i,
    );
  const filtered = past
    .filter((entry) => historyMatches(entry.command, query, prefixSearch))
    .reverse();
  const suggestion =
    input && !input.includes("\n")
      ? past.find(
          (entry) => entry.command.startsWith(input) && entry.command !== input,
        )?.command
      : undefined;
  const change = (value: string) => {
    version.current++;
    setInput(value);
    setSelection(value.length);
    setMenu(null);
    setError(null);
  };
  const fill = (value: string) => {
    change(value);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(value.length, value.length);
    });
  };
  const openHistory = (focus = false) => {
    setPrefixSearch(!focus);
    setQuery(input);
    setIndex(
      Math.max(
        0,
        past.filter((entry) => historyMatches(entry.command, input, !focus))
          .length - 1,
      ),
    );
    setMenu("history");
    if (focus) requestAnimationFrame(() => search.current?.focus());
  };
  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setCommand: fill,
    clear: () => change(""),
    history: () => openHistory(true),
    insert: (text) => {
      const start = textarea.current?.selectionStart ?? input.length;
      const end = textarea.current?.selectionEnd ?? start;
      change(input.slice(0, start) + text + input.slice(end));
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(
          start + text.length,
          start + text.length,
        );
      });
    },
  }));
  useEffect(() => {
    if (visible && !disabled) textarea.current?.focus();
  }, [visible, disabled]);
  useEffect(() => {
    document
      .getElementById(`${id}-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [id, index]);
  const apply = (at: number) => {
    if (menu === "history") {
      if (filtered[at]) fill(filtered[at].command);
      return;
    }
    const match = completion?.matches[at];
    if (!match || !completion) return;
    const { line } = base.current;
    const next =
      line.slice(0, completion.replacementIndex) +
      match.text +
      line.slice(completion.replacementIndex + completion.replacementLength);
    fill(next);
  };
  async function complete() {
    if (sessionId === null || pending) return;
    if (menu === "completion" && completion?.matches.length) {
      setIndex((i) => (i + 1) % completion.matches.length);
      return;
    }
    const captured = version.current;
    const cursor = textarea.current?.selectionStart ?? input.length;
    base.current = { line: input, cursor };
    setPending(true);
    setError(null);
    try {
      const result = await commands.completeTerminal(
        sessionId,
        input,
        cursor,
        cwd,
      );
      if (captured !== version.current) return;
      if (result.status === "error") throw new Error(result.error.message);
      const data = result.data;
      setCompletion(data);
      setIndex(0);
      if (data.matches.length === 1) {
        const match = data.matches[0];
        fill(
          input.slice(0, data.replacementIndex) +
            match.text +
            input.slice(data.replacementIndex + data.replacementLength),
        );
      } else if (data.matches.length) {
        setMenu("completion");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  const count =
    menu === "history" ? filtered.length : (completion?.matches.length ?? 0);
  const navigate = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (
      event.ctrlKey &&
      event.key.toLowerCase() === "c" &&
      textarea.current?.selectionStart === textarea.current?.selectionEnd
    ) {
      event.preventDefault();
      change("");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      openHistory(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMenu(null);
      textarea.current?.focus();
      return;
    }
    if (menu && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      if (
        menu === "history" &&
        event.key === "ArrowDown" &&
        index === count - 1
      ) {
        setMenu(null);
        textarea.current?.focus();
      } else
        setIndex((i) =>
          count ? (i + (event.key === "ArrowUp" ? count - 1 : 1)) % count : 0,
        );
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (menu) {
        apply(index);
        return;
      }
      if (input.trim()) {
        onRun(input);
        change("");
      }
      return;
    }
  };
  return (
    <form
      className="terminal-command-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && input.trim()) {
          onRun(input);
          change("");
        }
      }}
    >
      {menu && (
        <div
          className="terminal-input-menu"
          role="dialog"
          aria-label={
            menu === "history" ? "Command history" : "Shell completions"
          }
        >
          <header>
            {menu === "history" ? (
              <>
                <SearchIcon size={14} />
                <input
                  ref={search}
                  aria-label="Search command history"
                  placeholder="Search history…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPrefixSearch(false);
                    setIndex(0);
                  }}
                  onKeyDown={navigate}
                />
              </>
            ) : (
              <strong>Shell completions</strong>
            )}
            <span className="grow" />
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Close suggestions"
              onClick={() => {
                setMenu(null);
                textarea.current?.focus();
              }}
            >
              <XIcon size={14} />
            </button>
          </header>
          <div
            id={`${id}-options`}
            role="listbox"
            aria-label={
              menu === "history" ? "Previous commands" : "Completion results"
            }
          >
            {menu === "history"
              ? filtered.map((entry, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === i}
                    id={`${id}-${i}`}
                    key={`${entry.at}:${entry.command}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => apply(i)}
                  >
                    <HistoryIcon size={13} />
                    <code>{entry.command}</code>
                    <span>
                      {entry.exitCode !== null && entry.exitCode !== 0
                        ? `exit ${entry.exitCode}`
                        : new Date(entry.at).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                    </span>
                  </button>
                ))
              : completion?.matches.map((entry, i) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === i}
                    id={`${id}-${i}`}
                    key={`${entry.text}:${i}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => apply(i)}
                  >
                    <code>{entry.label}</code>
                    <span title={entry.detail}>{entry.detail}</span>
                  </button>
                ))}
            {count === 0 && <p className="dim">No matching commands.</p>}
          </div>
          <footer>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate <kbd>Enter</kbd> insert <kbd>Esc</kbd> dismiss
          </footer>
        </div>
      )}
      <div className="terminal-command-entry">
        <span className="terminal-prompt-symbol" aria-hidden="true">
          {/Windows/i.test(navigator.userAgent) ? "PS>" : "$"}
        </span>
        <div className="terminal-input-editor">
          {suggestion && selection === input.length && (
            <div className="terminal-ghost" aria-hidden="true">
              <span>{input}</span>
              {suggestion.slice(input.length)}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="Terminal command"
            aria-expanded={menu !== null}
            aria-controls={menu ? `${id}-options` : undefined}
            value={input}
            rows={Math.min(8, input.split("\n").length)}
            disabled={disabled}
            spellCheck={false}
            placeholder={sessionId === null ? "Starting shell…" : ""}
            onSelect={(event) =>
              setSelection(event.currentTarget.selectionStart)
            }
            onChange={(event) => change(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Tab") {
                event.preventDefault();
                void complete();
                return;
              }
              if (
                event.key === "ArrowRight" &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                suggestion &&
                event.currentTarget.selectionStart === input.length &&
                event.currentTarget.selectionEnd === input.length
              ) {
                event.preventDefault();
                fill(suggestion);
                return;
              }
              if (!menu && event.key === "ArrowUp" && !input.includes("\n")) {
                event.preventDefault();
                openHistory();
                return;
              }
              navigate(event);
            }}
          />
        </div>
        <button
          type="submit"
          className="icon-btn"
          disabled={disabled || !input.trim()}
          aria-label="Run command"
        >
          <PlayIcon size={16} />
        </button>
      </div>
      {fresh && (
        <div className="terminal-command-hint">
          <span>
            {pending
              ? "Completing…"
              : suggestion
                ? "→ accept suggestion · Tab complete · ↑ history"
                : "Tab complete · ↑ history · Shift+Enter new line"}
          </span>
          <button
            type="button"
            className="link"
            disabled={disabled}
            onClick={() => openHistory(true)}
          >
            Ctrl+R
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
