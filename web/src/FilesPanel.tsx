import { useEffect, useState } from "react";
import { FileIcon, FoldIcon, SearchIcon } from "@primer/octicons-react";
import { commands } from "./bindings";
import { EditorFileTree } from "./EditorFileTree";

interface FilesPanelProps {
  projectId: number;
  threadId: number | null;
  /** Changes after checkout mutations (commits, checkouts, Turns), so the tree refetches. */
  revision: number;
  /** Opens the file in the Project's central Code workspace. */
  onOpenFile: (path: string) => void;
}

/** The tree belongs to one checkout, so a different one remounts it. */
export function FilesPanel(props: FilesPanelProps) {
  return <FilesExplorer key={`${props.projectId}:${props.threadId}`} {...props} />;
}

/** The Files Surface: a full-width navigator. A click selects; a double click opens Code. */
function FilesExplorer({ projectId, threadId, revision, onOpenFile }: FilesPanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [collapseToken, setCollapseToken] = useState(0);
  const [query, setQuery] = useState("");
  // The query the results belong to; a newer query renders as still searching.
  const [search, setSearch] = useState<{ query: string; results: string[]; error: string | null } | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    let active = true;
    const timer = setTimeout(() => {
      void commands
        .findFiles(projectId, threadId, trimmed)
        .then((result) => {
          if (!active) return;
          setSearch(result.status === "ok"
            ? { query: trimmed, results: result.data, error: null }
            : { query: trimmed, results: [], error: result.error.message });
        })
        .catch((cause: unknown) => {
          if (active) {
            setSearch({ query: trimmed, results: [], error: cause instanceof Error ? cause.message : String(cause) });
          }
        });
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, threadId, query]);

  const trimmedQuery = query.trim();
  const currentSearch = trimmedQuery && search?.query === trimmedQuery ? search : null;
  const searching = Boolean(trimmedQuery) && currentSearch === null;

  return (
    <section className="files files-navigation" aria-label="Files">
      <div className="files-toolbar">
        <label className="files-search">
          <SearchIcon size={12} />
          <input
            type="search"
            placeholder="Search files"
            aria-label="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
          />
        </label>
        <button
          className="icon-btn sm"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          onClick={() => setCollapseToken((token) => token + 1)}
        >
          <FoldIcon size={14} />
        </button>
      </div>
      {trimmedQuery ? (
        <div className="files-search-results" role="listbox" aria-label="File search results">
          {searching && <p className="files-note">Searching…</p>}
          {!searching && currentSearch?.error && <p className="files-note error" role="alert">{currentSearch.error}</p>}
          {!searching && !currentSearch?.error && currentSearch?.results.length === 0 && <p className="files-note">No matching files.</p>}
          {(currentSearch?.results ?? []).map((path) => (
            <button
              key={path}
              role="option"
              className={`files-row${selected === path ? " files-row-selected" : ""}`}
              aria-selected={selected === path}
              title={path}
              onClick={() => setSelected(path)}
              onDoubleClick={() => onOpenFile(path)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpenFile(path);
                }
              }}
            >
              <span className="files-icon" aria-hidden><FileIcon size={14} /></span>
              <span className="files-name">{path}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="files-tree">
          <EditorFileTree
            projectId={projectId}
            threadId={threadId}
            selected={selected}
            onOpen={(path) => setSelected(path)}
            onKeep={onOpenFile}
            collapseToken={collapseToken}
            revision={revision}
          />
        </div>
      )}
    </section>
  );
}
