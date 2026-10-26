import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDirectoryFillIcon,
  FileDirectoryOpenFillIcon,
  FileIcon,
  LockIcon,
} from "@primer/octicons-react";
import { commands, type FileContent, type FileEntry } from "./bindings";
import { languageForPath, shouldHighlight } from "./fileLang";
import { highlighter } from "./highlighter";
import { fileTreeLayout } from "./panelLayout";
import { ResizeHandle } from "./ResizeHandle";
import { useElementSize, usePanelSize } from "./usePanelSize";

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
  const region = useRef<HTMLElement>(null);
  const treeId = useId();
  const size = useElementSize(region, { width: 0, height: 0 });
  const treeWidth = usePanelSize("files-width");
  const treeHeight = usePanelSize("files-height");
  const split = fileTreeLayout(size.width, size.height, { width: treeWidth.preferred, height: treeHeight.preferred });
  const preference = split.axis === "x" ? treeWidth : treeHeight;
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
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const indent = { paddingLeft: 8 + depth * 16 };
    const listing = listings[path];
    if (listing === undefined) return <div className="files-note" style={indent}>Loading…</div>;
    if ("error" in listing) return <div className="files-note error" style={indent}>{listing.error}</div>;
    if (listing.length === 0) return <div className="files-note" style={indent}>Empty</div>;
    return listing.map((entry) => (
      <div key={entry.path} role="treeitem" aria-selected={selected === entry.path} aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}>
        <button
          className={`files-row${selected === entry.path ? " files-row-selected" : ""}`}
          style={indent}
          title={entry.path}
          onClick={() => (entry.isDir ? toggle(entry.path) : setSelected(entry.path))}
        >
          <span className="files-chevron" aria-hidden>
            {entry.isDir && (expanded.has(entry.path) ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />)}
          </span>
          <span className={entry.isDir ? "files-icon dir" : "files-icon"} aria-hidden>
            {entry.isDir ? (
              expanded.has(entry.path) ? <FileDirectoryOpenFillIcon size={14} /> : <FileDirectoryFillIcon size={14} />
            ) : (
              <FileIcon size={14} />
            )}
          </span>
          <span className="files-name">{entry.name}</span>
        </button>
        {entry.isDir && expanded.has(entry.path) && <div role="group">{renderDir(entry.path, depth + 1)}</div>}
      </div>
    ));
  }

  return (
    <section className="files" aria-label="Files" ref={region} data-split-axis={split.axis} style={split.axis === "x"
      ? { gridTemplateColumns: `${split.value}px minmax(0, 1fr)` }
      : { gridTemplateRows: `${split.value}px minmax(0, 1fr)` }}>
      <div className="files-tree" role="tree" id={treeId}>
        {renderDir("", 0)}
      </div>
      <ResizeHandle key={split.axis} label="Resize file tree" controls={treeId} axis={split.axis} edge="end"
        value={split.value} min={split.min} max={split.max}
        style={split.axis === "x" ? { left: split.value - 4, right: "auto" } : { top: split.value - 4, bottom: "auto" }}
        onResize={preference.resize} onCommit={preference.commit} onReset={preference.reset} onCancel={preference.cancel} />
      {selected ? (
        <FileViewer key={selected} projectId={projectId} threadId={threadId} path={selected} />
      ) : (
        <div className="files-viewer files-viewer-empty">
          <FileIcon size={20} />
          <span>Pick a file to read it here.</span>
        </div>
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
      <div className="files-viewer-title">
        <span className="files-viewer-path" title={path}>{path}</span>
        <span className="chip" title="Oxide only reads files; edit them in your editor">
          <LockIcon size={12} /> read-only
        </span>
      </div>
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
        <div className="code-block numbered" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="code-block numbered">
          <pre className="shiki code-plain">
            <code>
              {file.content.split("\n").map((line, i) => (
                <span key={i} className="line">
                  {line}
                  {"\n"}
                </span>
              ))}
            </code>
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
