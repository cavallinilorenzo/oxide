import { useEffect, useState } from "react";
import {
  CheckCircleIcon,
  CopyIcon,
  LinkExternalIcon,
  SyncIcon,
  TerminalIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands, type LanguageTool } from "./bindings";
import { InstallLanguageButton } from "./LanguageSupport";

export function LanguageTools({
  onClose,
  onRunCommand,
  onChanged,
}: {
  onClose: () => void;
  onRunCommand: (command: string) => void;
  onChanged: () => void;
}) {
  const [tools, setTools] = useState<LanguageTool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [argumentDrafts, setArgumentDrafts] = useState<Record<string, string>>(
    {},
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void commands
      .languageTools()
      .then((result) => {
        if (active) {
          setTools(result);
          setArgumentDrafts(
            Object.fromEntries(
              result.map((tool) => [
                tool.language,
                JSON.stringify(tool.config.args),
              ]),
            ),
          );
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const update = (
    language: string,
    field: "command" | "interpreter",
    value: string,
  ) =>
    setTools((previous) =>
      previous.map((t) =>
        t.language === language
          ? { ...t, config: { ...t.config, [field]: value } }
          : t,
      ),
    );
  async function save(tool: LanguageTool) {
    setBusy(true);
    setError(null);
    try {
      const args: unknown = JSON.parse(argumentDrafts[tool.language] ?? "[]");
      if (
        !Array.isArray(args) ||
        args.some((value) => typeof value !== "string")
      )
        throw new Error("Arguments must be a JSON array of strings.");
      const result = await commands.configureLanguageServer(tool.language, {
        ...tool.config,
        args: args.map(String),
      });
      if (result.status === "error") throw new Error(result.error.message);
      setRevision((n) => n + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="language-tools" aria-label="Language tools">
      <header>
        <div>
          <h2>Language tools</h2>
          <p>Local intelligence for your code. No extensions required.</p>
        </div>
        <button
          className="icon-btn"
          onClick={onClose}
          aria-label="Close Language tools"
        >
          <XIcon size={16} />
        </button>
      </header>
      <p className="language-tools-help">
        Download language support into Oxide’s private tools folder. Python and
        TypeScript use a private Node.js runtime when npm is unavailable. You
        can also configure your own executable and arguments.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          setRevision((n) => n + 1);
          onChanged();
        }}
      >
        <SyncIcon size={14} /> Recheck installed tools
      </button>
      {tools.map((tool) => (
        <section key={tool.language} className="language-tool">
          <header>
            <h3>{tool.name}</h3>
            <span className={tool.installed ? "language-ready" : "dim"}>
              {tool.installed && <CheckCircleIcon size={14} />}{" "}
              {tool.installed ? "Installed" : "Not installed"}
            </span>
          </header>
          <label>
            Executable
            <input
              value={tool.config.command}
              spellCheck={false}
              onChange={(e) => update(tool.language, "command", e.target.value)}
            />
          </label>
          <label>
            Arguments (JSON array)
            <input
              value={argumentDrafts[tool.language] ?? "[]"}
              spellCheck={false}
              onChange={(e) =>
                setArgumentDrafts((previous) => ({
                  ...previous,
                  [tool.language]: e.target.value,
                }))
              }
            />
          </label>
          {tool.language === "python" && (
            <label>
              Python interpreter (optional)
              <input
                placeholder="Path to python.exe or your virtual environment"
                value={tool.config.interpreter ?? ""}
                onChange={(e) =>
                  update(tool.language, "interpreter", e.target.value)
                }
              />
            </label>
          )}
          {tool.resolvedPath && (
            <p className="mono language-path" title={tool.resolvedPath}>
              {tool.resolvedPath}
            </p>
          )}
          {tool.language === "cpp" && (
            <p className="dim">
              For project-aware errors, generate compile_commands.json or
              configure clangd with --compile-commands-dir.
            </p>
          )}
          <div className="language-tool-actions">
            <button
              className="btn"
              disabled={busy || !tool.config.command.trim()}
              onClick={() => void save(tool)}
            >
              Save configuration
            </button>
            <a
              href={tool.documentation}
              onClick={(event) => {
                event.preventDefault();
                void commands
                  .openLink(tool.documentation)
                  .then((result) => {
                    if (result.status === "error")
                      setError(result.error.message);
                  })
                  .catch((e: Error) => setError(e.message));
              }}
              target="_blank"
              rel="noreferrer"
            >
              Setup guide <LinkExternalIcon size={12} />
            </a>
          </div>
          <InstallLanguageButton
            tool={tool}
            onInstalled={() => {
              setRevision((n) => n + 1);
            }}
          />
          <details className="language-manual">
            <summary>Manual installation</summary>
            <div className="language-install">
              <code>{tool.installCommand}</code>
              <button
                className="icon-btn sm"
                aria-label={`Copy ${tool.language} install command`}
                onClick={() =>
                  void navigator.clipboard.writeText(tool.installCommand)
                }
              >
                <CopyIcon size={14} />
              </button>
            </div>
            <button
              className="btn"
              onClick={() => onRunCommand(tool.installCommand)}
            >
              <TerminalIcon size={14} /> Run in Terminal
            </button>
          </details>
        </section>
      ))}
    </section>
  );
}
