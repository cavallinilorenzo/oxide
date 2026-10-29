import { lazy, Suspense, useEffect, useState } from "react";
import { CheckCircleIcon, DownloadIcon, MarkGithubIcon, LinkExternalIcon } from "@primer/octicons-react";
import { commands, type DeveloperTool } from "./bindings";
const TerminalWorkbench = lazy(() => import("./TerminalWorkbench").then((module) => ({ default: module.TerminalWorkbench })));

/** Shared recovery path for a fresh machine, also available from Settings. */
export function GithubSetup({ guidance, onReady, projectId }: { guidance?: string; onReady?: () => void; projectId?: number }) {
  const [tools, setTools] = useState<DeveloperTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [login, setLogin] = useState(false);
  const [loginCommand, setLoginCommand] = useState<{ id: number; command: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    void commands.developerTools().then((result) => {
      if (!active) return;
      if (result.status === "error") throw new Error(result.error.message);
      setTools(result.data);
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [revision]);
  const install = async (tool: DeveloperTool) => {
    setInstalling(tool.id);
    setError(null);
    try {
      const result = await commands.installDeveloperTool(tool.id);
      if (result.status === "error") throw new Error(result.error.message);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setInstalling(null); setRevision((v) => v + 1); }
  };
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await commands.developerTools();
      if (result.status === "error") throw new Error(result.error.message);
      setTools(result.data);
      if (result.data.length === 2 && result.data.every((t) => t.installed)) {
        if (projectId !== undefined) {
          const state = await commands.issuesState(projectId);
          if (state.status === "error") throw new Error(state.error.message);
          if (state.data.availability !== "ready") throw new Error(state.data.guidance ?? "Sign in to GitHub, then check again.");
        }
        onReady?.();
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  };
  const installed = tools?.length === 2 && tools.every((tool) => tool.installed);
  return <section className="github-setup" aria-label="GitHub setup">
    <header><MarkGithubIcon size={24} /><div><h3>Set up GitHub</h3><p>Install the tools once to work with repositories, pull requests and issues.</p></div></header>
    {!tools && !error && <p className="dim">Checking installed tools…</p>}
    <ol className="github-setup-steps">
      {tools?.map((tool) => <li key={tool.id}>
        <span className={`setup-step-state${tool.installed ? " complete" : ""}`}>{tool.installed ? <CheckCircleIcon size={18} /> : <DownloadIcon size={18} />}</span>
        <div><strong>{tool.name}</strong><p>{tool.id === "git" ? "Version control and local repositories" : "Pull requests, issues and your GitHub account"}</p><small className="dim" title={tool.path ?? undefined}>{tool.installed ? "Installed" : "Not installed"}</small></div>
        {tool.installed ? null : tool.canInstall ? <button className="btn" disabled={installing !== null || checking} onClick={() => void install(tool)}>{installing === tool.id ? "Installing…" : `Install ${tool.name}`}</button> : <button className="btn" disabled={installing !== null} onClick={() => void commands.openLink(tool.documentation).then((r) => { if (r.status === "error") setError(r.error.message); }).catch((e) => setError(String(e)))}>Installation guide <LinkExternalIcon size={12} /></button>}
      </li>)}
      {installed && onReady && <li><span className="setup-step-state"><MarkGithubIcon size={18} /></span><div><strong>Sign in to GitHub</strong><p>Connect your account, then check again to continue.</p></div>
        {projectId !== undefined ? <button className="btn" disabled={login} onClick={() => { setLogin(true); setLoginCommand({ id: Date.now(), command: "gh auth login --web --git-protocol https" }); }}>Open sign-in terminal</button> : <button className="btn" onClick={() => void navigator.clipboard.writeText("gh auth login --web --git-protocol https").then(() => setCopied(true)).catch((e) => setError(String(e)))}>{copied ? "Copied — run in your terminal" : "Copy sign-in command"}</button>}
      </li>}
    </ol>
    {installing && <p role="status" className="settings-note">Installing with your system package manager. The installer may ask for permission. This can take a few minutes.</p>}
    {tools?.some((tool) => !tool.installed && !tool.canInstall) && <p className="settings-note">Use the official installer, then check again. If the tool is still missing, restart Oxide to refresh its PATH.</p>}
    {guidance && <p className="settings-note">{guidance}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {login && projectId !== undefined && <div className="github-signin-terminal"><Suspense fallback={<p>Starting sign-in terminal…</p>}><TerminalWorkbench projectId={projectId} threadId={null} rootPath="" contextKey={`github-setup:${projectId}`} visible queuedCommand={loginCommand} onCommandConsumed={() => setLoginCommand(null)} /></Suspense></div>}
    <div className="github-setup-footer"><button className="btn" disabled={installing !== null || checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button><span className="dim">{installed ? "Both tools are available." : "Nothing is downloaded until you choose Install."}</span></div>
  </section>;
}
