import { useEffect, useState } from "react";
import { commands, type FileContent, type FileEntry } from "./bindings";
import { languageForPath, shouldHighlight } from "./fileLang";
import { highlighter } from "./highlighter";

interface FilesPanelProps {
  projectId: number;
  threadId: number | null;
}

/** A directory's entries once loaded, or why they couldn't be; absent while loading. */
type Listing = FileEntry[] | { error: string };

/** The tree belongs to one checkout, so a different one remounts it. */
export function FilesPanel(props: FilesPanelProps) {
  return <FilesTree key={`${props.projectId}:${props.threadId}`} {...props} />;
}

function FilesTree({ projectId, threadId }: FilesPanelProps) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  function load(path: string) {
    return commands.listDir(projectId, threadId, path).then((result) => {
      const listing = result.status === "ok" ? result.data : { error: result.error.message };
      setListings((prev) => ({ ...prev, [path]: listing }));
    });
  }

  useEffect(() => {
    void commands.listDir(projectId, threadId, "").then((result) => {
      const listing = result.status === "ok" ? result.data : { error: result.error.message };
      setListings((prev) => ({ ...prev, "": listing }));
    });
  }, [projectId, threadId]);

  function toggle(path: string) {
    const open = expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!open && listings[path] === undefined) void load(path);
  }

  function renderDir(path: string, depth: number) {
    const indent = { paddingLeft: 8 + depth * 12 };
    const listing = listings[path];
    if (listing === undefined) return <div className="files-note" style={indent}>Loading…</div>;
    if ("error" in listing) return <div className="files-note error" style={indent}>{listing.error}</div>;
    if (listing.length === 0) return <div className="files-note" style={indent}>Empty</div>;
    return listing.map((entry) => (
      <div key={entry.path} role="treeitem" aria-selected={selected === entry.path} aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}>
        <button
          className={`files-row${selected === entry.path ? " files-row-selected" : ""}`}
          style={indent}
          onClick={() => (entry.isDir ? toggle(entry.path) : setSelected(entry.path))}
        >
          <span aria-hidden>{entry.isDir ? (expanded.has(entry.path) ? "▾" : "▸") : " "}</span> {entry.name}
        </button>
        {entry.isDir && expanded.has(entry.path) && <div role="group">{renderDir(entry.path, depth + 1)}</div>}
      </div>
    ));
  }

  return (
    <section className="files" aria-label="Files">
      <div className="files-tree" role="tree">
        {renderDir("", 0)}
      </div>
      {selected && (
        <FileViewer key={selected} projectId={projectId} threadId={threadId} path={selected} />
      )}
    </section>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; file: FileContent; html?: string };

function FileViewer({ projectId, threadId, path }: { projectId: number; threadId: number | null; path: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await commands.readFile(projectId, threadId, path);
      if (!active) return;
      if (result.status === "error") return setLoaded({ state: "error", message: result.error.message });
      const file = result.data;
      // Plain text first; the worker's highlighting swaps in when ready.
      setLoaded({ state: "ready", file });
      if (file.binary || !shouldHighlight(file.content)) return;
      try {
        const html = await highlighter().highlight(file.content, languageForPath(path));
        if (active) setLoaded({ state: "ready", file, html });
      } catch {
        // Stays plain text.
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, threadId, path]);

  return (
    <div className="files-viewer" aria-label={`File ${path}`}>
      <div className="files-viewer-title">{path}</div>
      {loaded.state === "loading" && <div className="files-note">Loading…</div>}
      {loaded.state === "error" && <div className="files-note error">{loaded.message}</div>}
      {loaded.state === "ready" && <FileBody file={loaded.file} html={loaded.html} />}
    </div>
  );
}

function FileBody({ file, html }: { file: FileContent; html?: string }) {
  if (file.binary) return <div className="files-note">Binary file ({formatSize(file.size)})</div>;
  return (
    <>
      {file.truncated && <div className="files-note">Showing the first 1 MB of {formatSize(file.size)}.</div>}
      {html !== undefined ? (
        // Shiki's output, generated from escaped source in our own worker.
        <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="code-block">
          <pre className="shiki code-plain">
            <code>{file.content}</code>
          </pre>
        </div>
      )}
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
