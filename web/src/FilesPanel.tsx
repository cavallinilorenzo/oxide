import { Skeleton } from "./Skeleton";
import { useEffect, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileDirectoryFillIcon,
  FileDirectoryOpenFillIcon,
  FileIcon,
} from "@primer/octicons-react";
import { commands, type FileEntry } from "./bindings";

interface FilesPanelProps {
  projectId: number;
  threadId: number | null;
  onOpenFile: (path: string) => void;
}

/** A directory's entries once loaded, or why they couldn't be; absent while loading. */
type Listing = FileEntry[] | { error: string };

/** The tree belongs to one checkout, so a different one remounts it. */
export function FilesPanel(props: FilesPanelProps) {
  return <FilesTree key={`${props.projectId}:${props.threadId}`} {...props} />;
}

function FilesTree({ projectId, threadId, onOpenFile }: FilesPanelProps) {
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
    if (listing === undefined) return <Skeleton kind="tree" label="Loading directory…" rows={depth === 0 ? 7 : 3} style={indent} />;
    if ("error" in listing) return <div className="files-note error" style={indent}>{listing.error}</div>;
    if (listing.length === 0) return <div className="files-note" style={indent}>Empty</div>;
    return listing.map((entry) => (
      <div key={entry.path} role="treeitem" aria-selected={selected === entry.path} aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}>
        <button
          className={`files-row${selected === entry.path ? " files-row-selected" : ""}`}
          style={indent}
          title={entry.path}
          onClick={() => { if (entry.isDir) toggle(entry.path); else { setSelected(entry.path); onOpenFile(entry.path); } }}
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
    <section className="files files-navigation" aria-label="Files">
      <div className="files-tree" role="tree">
        {renderDir("", 0)}
      </div>
    </section>
  );
}
