import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AlertIcon,
  CheckIcon,
  CodeIcon,
  FileCodeIcon,
  FileIcon,
  ChevronDownIcon,
  FoldIcon,
  GearIcon,
  ListUnorderedIcon,
  PlusIcon,
  SearchIcon,
  SyncIcon,
  XIcon,
} from "@primer/octicons-react";
import { commands } from "./bindings";
import { monaco, editorLanguage, serverLanguage } from "./editorRuntime";
import { EditorLanguages } from "./editorLanguages";
import { EditorFileTree } from "./EditorFileTree";
import { LanguageTools } from "./LanguageTools";
import { LanguageSupportNotice } from "./LanguageSupport";
import { Skeleton } from "./Skeleton";
import { fontStyle, getAppearance } from "./appearance";
import { registerEditorSave } from "./editorSaves";
import { invalidateQueries } from "./queryCache";
import { shortcutLabel } from "./shortcuts";
import { hunkTarget, patchDocument, type CodeOpenRequest } from "./codeOpen";
import { batchCloseTargets, neighborAfterClose, previewToReplace } from "./editorTabs";

/** Dock width below which the file list becomes a toggled overlay. */
const COMPACT_WIDTH = 560;
type CloseChoice = "save" | "discard" | "cancel";

interface Document {
  readOnly?: boolean;
  sourcePath?: string;
  path: string;
  model: monaco.editor.ITextModel;
  saved: string;
  dirty: boolean;
  view: monaco.editor.ICodeEditorViewState | null;
  saving: boolean;
  /** Replaced by the next single-click open until it is edited or double-clicked. */
  preview?: boolean;
  /** The reviewed revision may differ from the local file, so hunk lines can't be trusted. */
  remote?: boolean;
  /** Opened from a Diff hunk, so Back to Diff is offered. */
  fromDiff?: boolean;
  listener?: monaco.IDisposable;
}
interface Problem {
  path: string;
  marker: monaco.editor.IMarker;
}
interface Props {
  openRequest?: CodeOpenRequest | null;
  projectId: number;
  threadId: number | null;
  rootPath: string;
  contextKey: string;
  visible: boolean;
  onChanged: () => void;
  onRunCommand: (command: string) => void;
  /** Shows the Diff Surface again, where the comparison, file and scroll were left. */
  onBackToDiff?: () => void;
}

export function CodeWorkbench({
  projectId,
  threadId,
  rootPath,
  contextKey,
  visible,
  onChanged,
  onRunCommand,
  openRequest,
  onBackToDiff,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const languages = useRef<EditorLanguages | null>(null);
  const records = useRef(new Map<string, Document>());
  const opening = useRef(new Set<string>());
  const [documents, setDocuments] = useState<Document[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tools, setTools] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [newFile, setNewFile] = useState<string | null>(null);
  const [treeRevision, setTreeRevision] = useState(0);
  const [closing, setClosing] = useState<string | null>(null);
  const closeAnswer = useRef<((choice: CloseChoice) => void) | null>(null);
  const [compact, setCompact] = useState(false);
  const [treeOpen, setTreeOpen] = useState(false);
  const [filesMenu, setFilesMenu] = useState(false);
  const root = useRef<HTMLElement>(null);
  const treeToggle = useRef<HTMLButtonElement>(null);
  const [states, setStates] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const [problems, setProblems] = useState<Problem[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const dirtyState = useRef(false);
  const requestedFile = useRef(openRequest);
  useLayoutEffect(() => { requestedFile.current = openRequest; }, [openRequest]);

  const publish = useCallback(() => {
    const docs = [...records.current.values()];
    setDocuments(docs.map((d) => ({ ...d })));
    const dirty = docs.some((d) => d.dirty);
    if (dirty !== dirtyState.current) {
      dirtyState.current = dirty;
      void commands.setEditorDirty(contextKey, dirty).catch(() => {});
    }
    try {
      localStorage.setItem(
        `oxide:code-tabs:${contextKey}`,
        JSON.stringify(docs.filter((d) => !d.readOnly).map((d) => d.path)),
      );
    } catch {
      /* Editing works without UI persistence. */
    }
  }, [contextKey]);

  const select = useCallback((doc: Document, selection?: monaco.IRange) => {
    const instance = editor.current;
    if (!instance) return;
    const previous = [...records.current.values()].find(
      (d) => d.model === instance.getModel(),
    );
    if (previous) previous.view = instance.saveViewState();
    instance.setModel(doc.model);
    instance.updateOptions({ readOnly: doc.readOnly ?? false });
    if (doc.view) instance.restoreViewState(doc.view);
    if (selection) {
      instance.setSelection(selection);
      instance.revealRangeInCenter(selection);
    }
    setActive(doc.path);
    instance.focus();
  }, []);

  /** Drops a document and its model without asking; callers decide whether that is allowed. */
  const discardDocument = useCallback(
    (path: string) => {
      const doc = records.current.get(path);
      if (!doc) return;
      const order = [...records.current.keys()];
      const selected = editor.current?.getModel() === doc.model;
      if (selected) editor.current?.setModel(null);
      languages.current?.remove(doc.model);
      records.current.delete(path);
      doc.listener?.dispose();
      doc.model.dispose();
      publish();
      if (selected) {
        const next = records.current.get(neighborAfterClose(order, path) ?? "");
        if (next) select(next);
        else setActive(null);
      }
    },
    [publish, select],
  );
  const openFile = useCallback(
    async (path: string, selection?: monaco.IRange, reveal = true, keep = true) => {
      const existing = records.current.get(path);
      if (existing) {
        if (keep && existing.preview) {
          existing.preview = false;
          publish();
        }
        if (reveal) select(existing, selection);
        return;
      }
      if (opening.current.has(path)) return;
      opening.current.add(path);
      setLoading(true);
      setError(null);
      try {
        const result = await commands.readFile(projectId, threadId, path);
        if (result.status === "error") throw new Error(result.error.message);
        if (result.data.binary || result.data.truncated)
          throw new Error(
            "Open a complete UTF-8 text file up to 1 MiB to edit it. Binary and larger files remain available in Files.",
          );
        if (!editor.current) return;
        const uri = monaco.Uri.file(
          `${rootPath.replace(/[\\/]$/, "")}/${path}`,
        );
        // The same checkout has one workbench, so its models have one owner.
        const model = monaco.editor.createModel(
          result.data.content,
          editorLanguage(path),
          uri,
        );
        // A new preview takes the place of the unmodified one; dirty or kept files stay.
        const stale = keep ? null : previewToReplace([...records.current.values()].map((d) => ({ path: d.path, preview: !!d.preview, dirty: d.dirty })));
        if (stale) discardDocument(stale);
        const doc: Document = {
          path,
          model,
          saved: result.data.content,
          dirty: false,
          view: null,
          saving: false,
          preview: !keep,
        };
        doc.listener = model.onDidChangeContent(() => {
          doc.dirty = model.getValue() !== doc.saved;
          if (doc.dirty) doc.preview = false;
          languages.current?.changed(model);
          publish();
        });
        records.current.set(path, doc);
        languages.current?.add(model);
        publish();
        if (reveal) select(doc, selection);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        opening.current.delete(path);
        setLoading(opening.current.size > 0);
      }
    },
    [projectId, threadId, rootPath, publish, select, discardDocument],
  );

  const saveDocument = useCallback(
    async (doc: Document): Promise<boolean> => {
      if (doc.readOnly || !doc.dirty) return true;
      if (doc.saving) return false;
      const content = doc.model.getValue();
      doc.saving = true;
      publish();
      setError(null);
      try {
        const result = await commands.writeFile(
          projectId,
          threadId,
          doc.path,
          doc.saved,
          content,
        );
        if (result.status === "error") throw new Error(result.error.message);
        doc.saved = content;
        doc.dirty = doc.model.getValue() !== content;
        languages.current?.saved(doc.model);
        invalidateQueries(`p${projectId}:diff:`, { drop: true });
        onChanged();
        return true;
      } catch (e) {
        setError(`${doc.path}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        doc.saving = false;
        publish();
      }
    },
    [projectId, threadId, publish, onChanged],
  );
  const saveAll = useCallback(async () => {
    for (const doc of records.current.values())
      if (!(await saveDocument(doc))) return false;
    return true;
  }, [saveDocument]);

  const ask = useCallback(
    (path: string) =>
      new Promise<CloseChoice>((resolve) => {
        closeAnswer.current = resolve;
        setClosing(path);
      }),
    [],
  );
  /** The one close policy: clean files close, dirty ones ask Save / Discard / Cancel, and Cancel stops a batch. */
  const requestClose = useCallback(
    async (paths: string[]) => {
      for (const path of paths) {
        const doc = records.current.get(path);
        if (!doc) continue;
        if (doc.dirty && !doc.readOnly) {
          if (active !== path) select(doc);
          const choice = await ask(path);
          setClosing(null);
          closeAnswer.current = null;
          if (choice === "cancel") return false;
          if (choice === "save" && !(await saveDocument(doc))) return false;
        }
        discardDocument(path);
      }
      return true;
    },
    [active, ask, discardDocument, saveDocument, select],
  );
  const closeFile = useCallback((path: string) => void requestClose([path]), [requestClose]);
  const openTree = useCallback(() => {
    setTreeOpen(true);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".editor-explorer button.files-row, .editor-explorer header button")?.focus());
  }, []);
  const closeTree = useCallback(() => {
    setTreeOpen(false);
    treeToggle.current?.focus();
  }, []);
  // Narrow docks show the file list as an overlay instead of a permanent split.
  useEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width > 0) setCompact(width < COMPACT_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The active file stays visible in a scrolling bar.
  useEffect(() => {
    if (!active) return;
    const tabs = root.current?.querySelectorAll<HTMLElement>(".editor-tab.active");
    tabs?.[0]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, documents.length]);
  const actions = useRef({ openFile, saveAll, saveDocument, closeFile, requestClose });
  useLayoutEffect(() => {
    actions.current = { openFile, saveAll, saveDocument, closeFile, requestClose };
  });

  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, {
      model: null,
      theme: "oxide",
      automaticLayout: true,
      fontSize: fontStyle("code").size,
      fontWeight: String(fontStyle("code").weight),
      fontFamily: getAppearance().fonts.code,
      fontLigatures: true,
      minimap: { enabled: false },
      padding: { top: 16, bottom: 16 },
      tabSize: 4,
      insertSpaces: true,
      autoIndent: "full",
      formatOnPaste: true,
      bracketPairColorization: { enabled: true },
      smoothScrolling: !window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      stickyScroll: { enabled: true },
    });
    editor.current = instance;
    const appearance=()=>instance.updateOptions({fontFamily:getAppearance().fonts.code, fontSize:fontStyle("code").size, fontWeight:String(fontStyle("code").weight)});
    window.addEventListener("oxide-appearance-changed",appearance);
    const bridge = new EditorLanguages(
      projectId,
      threadId,
      (language, state) =>
        setStates((previous) => ({ ...previous, [language]: state })),
      async (resource) => {
        const root = monaco.Uri.file(rootPath).path.replace(/\/$/, "");
        if (!resource.path.toLowerCase().startsWith(`${root}/`.toLowerCase()))
          throw new Error("Rename would edit a file outside the Project.");
        const path = resource.path.slice(root.length + 1);
        await actions.current.openFile(path, undefined, false);
        if (!records.current.has(path))
          throw new Error(`Could not open ${path} for renaming.`);
      },
    );
    languages.current = bridge;
    const reconnect = () => bridge.reconnect();
    window.addEventListener("oxide-language-tools-changed", reconnect);
    const ownedRecords = records.current;
    const cursorChange = instance.onDidChangeCursorPosition((e) =>
      setCursor(e.position),
    );
    const markers = monaco.editor.onDidChangeMarkers(() => {
      setProblems(
        [...records.current.values()].flatMap((doc) =>
          monaco.editor
            .getModelMarkers({ resource: doc.model.uri })
            .map((marker) => ({ path: doc.path, marker })),
        ),
      );
    });
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selection) => {
        const root = monaco.Uri.file(rootPath).path.replace(/\/$/, "");
        const full = resource.path;
        if (!full.toLowerCase().startsWith(`${root}/`.toLowerCase())) {
          setError(
            "This location is outside the Project. Open that folder as a Project to edit it.",
          );
          return true;
        }
        await actions.current.openFile(
          full.slice(root.length + 1),
          selection && "startLineNumber" in selection ? selection : undefined,
        );
        return true;
      },
    });
    const unregister = registerEditorSave(contextKey, () =>
      actions.current.saveAll(),
    );
    try {
      const restored: unknown = JSON.parse(
        localStorage.getItem(`oxide:code-tabs:${contextKey}`) ?? "[]",
      );
      if (Array.isArray(restored))
        void (async () => {
          for (const path of restored.slice(0, 12))
            if (typeof path === "string") await actions.current.openFile(path, undefined, false);
          if (!requestedFile.current && !instance.getModel()) {
            const last = [...ownedRecords.values()].at(-1);
            if (last) select(last);
          }
        })();
    } catch {
      /* Ignore an old or unavailable tab list. */
    }
    return () => {
      unregister();
      window.removeEventListener("oxide-appearance-changed",appearance);
      window.removeEventListener("oxide-language-tools-changed", reconnect);
      cursorChange.dispose();
      markers.dispose();
      opener.dispose();
      bridge.dispose();
      instance.dispose();
      editor.current = null;
      languages.current = null;
      for (const doc of ownedRecords.values()) {
        doc.listener?.dispose();
        doc.model.dispose();
      }
      ownedRecords.clear();
      void commands.setEditorDirty(contextKey, false).catch(() => {});
    };
  }, [projectId, threadId, rootPath, contextKey, publish, select]);

  useEffect(() => {
    if (!openRequest || !editor.current) return;
    if (!openRequest.diff) {
      void actions.current.openFile(openRequest.path, undefined, false).then(() => {
        const doc = records.current.get(openRequest.path);
        if (doc && requestedFile.current?.id === openRequest.id) select(doc);
      });
      return;
    }
    const path = `Changes: ${openRequest.path}`;
    const content = patchDocument(openRequest.diff);
    let doc = records.current.get(path);
    if (doc) { doc.model.setValue(content); doc.saved = content; }
    else {
      doc = { path, model: monaco.editor.createModel(content, "diff"), saved: content, dirty: false, view: null, saving: false, readOnly: true, sourcePath: openRequest.diff.status === "deleted" ? undefined : openRequest.path, remote: openRequest.remote };
      records.current.set(path, doc);
    }
    publish();
    select(doc);
  }, [openRequest, publish, select]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      editor.current?.layout();
      editor.current?.focus();
    });
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        setNewFile("");
      }
      if (e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen(true);
      }
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) void actions.current.saveAll();
        else {
          const doc = [...records.current.values()].find(
            (d) => d.model === editor.current?.getModel(),
          );
          if (doc) void actions.current.saveDocument(doc);
        }
      }
      if (e.key.toLowerCase() === "w") {
        e.preventDefault();
        const doc = [...records.current.values()].find(
          (d) => d.model === editor.current?.getModel(),
        );
        if (doc) void actions.current.requestClose([doc.path]);
      }
    };
    window.addEventListener("keydown", key, true);
    const edit = (event: Event) => {
      const instance = editor.current;
      if (!instance?.hasTextFocus()) return;
      const command = (event as CustomEvent<string>).detail;
      const action = (
        {
          undo: "undo",
          redo: "redo",
          cut: "editor.action.clipboardCutAction",
          copy: "editor.action.clipboardCopyAction",
          paste: "editor.action.clipboardPasteAction",
          selectAll: "editor.action.selectAll",
        } as Record<string, string>
      )[command];
      if (action) {
        event.preventDefault();
        instance.trigger("menu", action, null);
      }
    };
    window.addEventListener("oxide-editor-edit", edit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("oxide-editor-edit", edit);
    };
  }, [visible]);

  async function reload() {
    const doc = records.current.get(active ?? "");
    if (!doc || doc.readOnly) return;
    const result = await commands.readFile(projectId, threadId, doc.path);
    if (result.status === "error") {
      setError(result.error.message);
      return;
    }
    if (result.data.binary || result.data.truncated) {
      setError(
        "The file is now binary or larger than 1 MiB. Your buffer has been preserved.",
      );
      return;
    }
    doc.saved = result.data.content;
    doc.model.setValue(result.data.content);
    doc.dirty = false;
    publish();
    setError(null);
  }
  const current = documents.find((doc) => doc.path === active);
  const language = current
    ? serverLanguage(current.model.getLanguageId())
    : null;
  const errors = problems.filter(
    (p) => p.marker.severity === monaco.MarkerSeverity.Error,
  ).length;
  const warnings = problems.filter(
    (p) => p.marker.severity === monaco.MarkerSeverity.Warning,
  ).length;

  return (
    <main
      ref={root}
      className={`code-workbench${compact ? " compact" : ""}${compact && treeOpen ? " tree-open" : ""}`}
      aria-label="Code editor"
      hidden={!visible}
    >
      <aside
        className="editor-explorer"
        aria-label="File list"
        onKeyDown={(e) => {
          if (e.key === "Escape" && compact && treeOpen) closeTree();
        }}
      >
        <header>
          <span>Files</span>
          <button
            className="icon-btn sm"
            title="New file"
            aria-label="New file"
            onClick={() => setNewFile("")}
          >
            <PlusIcon size={14} />
          </button>
          <button
            className="icon-btn sm"
            title={`Find file (${shortcutLabel}P)`}
            aria-label="Find file"
            onClick={() => setQuickOpen(true)}
          >
            <SearchIcon size={14} />
          </button>
        </header>
        {newFile !== null && (
          <form
            className="editor-new-file"
            onSubmit={(e) => {
              e.preventDefault();
              const path = newFile.trim();
              if (!path) return;
              void commands
                .createFile(projectId, threadId, path)
                .then((result) => {
                  if (result.status === "error") setError(result.error.message);
                  else {
                    setNewFile(null);
                    setTreeRevision((n) => n + 1);
                    void openFile(path);
                    onChanged();
                  }
                });
            }}
          >
            <input
              autoFocus
              aria-label="New file path"
              value={newFile}
              onChange={(e) => setNewFile(e.target.value)}
              placeholder="folder/file.py"
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewFile(null);
              }}
            />
            <button
              type="submit"
              className="icon-btn sm"
              aria-label="Create file"
            >
              <CheckIcon size={14} />
            </button>
          </form>
        )}
        <EditorFileTree
          projectId={projectId}
          threadId={threadId}
          selected={current?.readOnly ? (current.sourcePath ?? null) : active}
          onOpen={(path) => {
            if (compact) closeTree();
            void openFile(path, undefined, true, false);
          }}
          onKeep={(path) => void openFile(path)}
          revision={treeRevision}
        />
      </aside>
      <div className="editor-main">
        <div className="editor-tabs-bar">
        {compact && (
          <button
            ref={treeToggle}
            className="icon-btn sm editor-tree-toggle"
            aria-label="Toggle file list"
            aria-expanded={treeOpen}
            title="File list"
            onClick={() => (treeOpen ? closeTree() : openTree())}
          >
            <ListUnorderedIcon size={14} />
          </button>
        )}
        <div className="editor-tabs" role="tablist" aria-label="Open files">
          {documents.map((doc) => (
            <div
              className={`editor-tab${active === doc.path ? " active" : ""}${doc.preview ? " preview" : ""}`}
              key={doc.path}
              data-path={doc.path}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void requestClose([doc.path]);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
            >
              <button
                role="tab"
                aria-selected={active === doc.path}
                title={doc.path}
                onClick={() => select(records.current.get(doc.path)!)}
                onDoubleClick={() => {
                  const record = records.current.get(doc.path);
                  if (record?.preview) {
                    record.preview = false;
                    publish();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Delete") {
                    e.preventDefault();
                    void requestClose([doc.path]);
                  }
                }}
              >
                <FileIcon size={13} />
                <span>{doc.readOnly ? "Changes: " : ""}{doc.path.split("/").pop()}</span>
                {doc.dirty && (
                  <span className="editor-dirty" aria-label="Unsaved changes" />
                )}
              </button>
              <button
                className="icon-btn sm"
                aria-label={`Close ${doc.path}`}
                onClick={() => void requestClose([doc.path])}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="editor-files-menu-wrap">
          <button
            className="icon-btn sm"
            aria-label="All open files"
            aria-haspopup="menu"
            aria-expanded={filesMenu}
            title="All open files"
            onClick={() => setFilesMenu((v) => !v)}
          >
            <ChevronDownIcon size={14} />
          </button>
          {filesMenu && (
            <div
              className="editor-files-menu"
              role="menu"
              aria-label="Open files"
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilesMenu(false);
              }}
            >
              {documents.length === 0 && <p className="dim">No open files.</p>}
              {documents.map((doc) => (
                <button
                  key={doc.path}
                  role="menuitem"
                  className={active === doc.path ? "selected" : ""}
                  onClick={() => {
                    setFilesMenu(false);
                    select(records.current.get(doc.path)!);
                  }}
                >
                  <FileIcon size={13} />
                  <span>{doc.readOnly ? "Changes: " : ""}{doc.path}</span>
                  {doc.dirty && <span className="editor-dirty" aria-label="Unsaved changes" />}
                </button>
              ))}
              <hr />
              <button
                role="menuitem"
                disabled={documents.length < 2 || !active}
                onClick={() => {
                  setFilesMenu(false);
                  void requestClose(batchCloseTargets(documents.map((d) => d.path), "others", active));
                }}
              >
                Close others
              </button>
              <button
                role="menuitem"
                disabled={documents.length === 0}
                onClick={() => {
                  setFilesMenu(false);
                  void requestClose(batchCloseTargets(documents.map((d) => d.path), "all", active));
                }}
              >
                Close all
              </button>
            </div>
          )}
        </div>
        <div className="editor-tabs-actions">
          <span className="grow" />
          <button
            className="icon-btn sm"
            aria-label="Language tools"
            title="Language tools"
            onClick={() => setTools((v) => !v)}
          >
            <GearIcon size={15} />
          </button>
        </div>
        </div>
        {current && (
          <div className="editor-breadcrumb">
            <span title={current.path}>{current.path}</span>
            {current.readOnly && <span className="chip">Git patch · read-only</span>}
            <span className="grow" />
            {current.sourcePath && (
              <button
                className="btn sm"
                onClick={() => {
                  const line = current.remote ? 1 : hunkTarget(current.model.getValue(), cursor.lineNumber);
                  const range = { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 };
                  const path = current.sourcePath!;
                  void openFile(path, range).then(() => {
                    const doc = records.current.get(path);
                    if (doc && !doc.fromDiff) {
                      doc.fromDiff = true;
                      publish();
                    }
                  });
                }}
              >
                Open in Code
              </button>
            )}
            {(current.fromDiff || current.readOnly) && onBackToDiff && (
              <button className="btn sm" onClick={onBackToDiff}>Back to Diff</button>
            )}
            <button
              className="btn sm"
              disabled={current.readOnly}
              onClick={() =>
                void editor.current
                  ?.getAction("editor.action.formatDocument")
                  ?.run()
              }
            >
              <FoldIcon size={13} /> Format
            </button>
            <button
              className="btn sm"
              disabled={!current.dirty || current.saving}
              onClick={() =>
                void saveDocument(records.current.get(current.path)!)
              }
            >
              {current.saving ? (
                <SyncIcon size={13} className="spin" />
              ) : (
                <CheckIcon size={13} />
              )}{" "}
              Save
            </button>
          </div>
        )}
        {language && (
          <LanguageSupportNotice
            key={language}
            language={language}
            onConfigure={() => setTools(true)}
          />
        )}
        {error && (
          <div className="editor-error" role="alert">
            <span>{error}</span>
            {current && (
              <button
                className="btn sm"
                onClick={() => {
                  if (!current.dirty) return void reload();
                  void ask(`reload:${current.path}`).then((choice) => {
                    setClosing(null);
                    closeAnswer.current = null;
                    if (choice === "discard") void reload();
                    if (choice === "save") void saveDocument(records.current.get(current.path)!);
                  });
                }}
              >
                Reload from disk
              </button>
            )}
            <button
              className="icon-btn sm"
              aria-label="Dismiss editor error"
              onClick={() => setError(null)}
            >
              <XIcon size={14} />
            </button>
          </div>
        )}
        <div className="editor-canvas">
          <div className="monaco-host" ref={host} />
          {!active && (
            <div className="editor-welcome">
              <FileCodeIcon size={36} />
              <h1>Your Project, open for editing.</h1>
              <p>Choose a file, or find one by name.</p>
              <button className="btn" onClick={() => setQuickOpen(true)}>
                <SearchIcon size={14} /> Find file <kbd>{shortcutLabel}P</kbd>
              </button>
              {compact && (
                <button className="btn" onClick={openTree}>
                  <ListUnorderedIcon size={14} /> Browse files
                </button>
              )}
              <button className="link" onClick={() => setTools(true)}>
                Set up language tools
              </button>
            </div>
          )}
          {loading && (
            <div className="editor-loading-skeleton"><Skeleton kind="code" label="Opening file…"/></div>
          )}
        </div>
        {showProblems && (
          <section className="editor-problems" aria-label="Problems">
            <header>
              Problems{" "}
              <button
                className="icon-btn sm"
                aria-label="Close Problems"
                onClick={() => setShowProblems(false)}
              >
                <XIcon size={14} />
              </button>
            </header>
            {problems.length === 0 ? (
              <p>No problems in open files.</p>
            ) : (
              problems.map(({ path, marker }, i) => (
                <button key={i} onClick={() => void openFile(path, marker)}>
                  <AlertIcon size={13} />
                  <span>{marker.message}</span>
                  <code>
                    {path}:{marker.startLineNumber}
                  </code>
                </button>
              ))
            )}
          </section>
        )}
        <footer className="editor-status">
          <button onClick={() => setShowProblems((v) => !v)}>
            <AlertIcon size={12} /> {errors} {errors === 1 ? "error" : "errors"}{" "}
            · {warnings} {warnings === 1 ? "warning" : "warnings"}
          </button>
          <span className="grow" />
          <span>
            Ln {cursor.lineNumber}, Col {cursor.column}
          </span>
          <button
            title={language ? states[language] : undefined}
            onClick={() => setTools(true)}
          >
            <CodeIcon size={12} />{" "}
            {current?.model.getLanguageId() ?? "Plain text"}
            {language &&
              ` · ${states[language] === "Ready" ? "LSP ready" : "Language tools"}`}
          </button>
        </footer>
      </div>
      {tools && (
        <div className="editor-language-panel">
          <LanguageTools
            onClose={() => setTools(false)}
            onRunCommand={onRunCommand}
            onChanged={() => languages.current?.reconnect()}
          />
        </div>
      )}
      {quickOpen && (
        <QuickOpen
          projectId={projectId}
          threadId={threadId}
          onClose={() => setQuickOpen(false)}
          onOpen={(path) => {
            setQuickOpen(false);
            void openFile(path);
          }}
        />
      )}
      {closing && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="alertdialog"
            aria-label="Unsaved file"
            onKeyDown={(e) => {
              if (e.key === "Escape") closeAnswer.current?.("cancel");
            }}
          >
            <h2>Keep your changes?</h2>
            <p>{closing.replace(/^reload:/, "")} has unsaved changes.</p>
            <div className="modal-actions">
              <button autoFocus onClick={() => closeAnswer.current?.("cancel")}>
                Cancel
              </button>
              <button onClick={() => closeAnswer.current?.("discard")}>
                Discard changes
              </button>
              <button className="primary" onClick={() => closeAnswer.current?.("save")}>
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function QuickOpen({
  projectId,
  threadId,
  onOpen,
  onClose,
}: {
  projectId: number;
  threadId: number | null;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void commands.findFiles(projectId, threadId, query).then((result) => {
        if (!active) return;
        if (result.status === "ok") {
          setFiles(result.data);
          setSelected(0);
        } else setError(result.error.message);
      });
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, threadId, query]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal editor-quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Find file"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((n) => Math.min(files.length - 1, n + 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((n) => Math.max(0, n - 1));
          }
          if (e.key === "Enter" && files[selected]) {
            e.preventDefault();
            onOpen(files[selected]);
          }
        }}
      >
        <input
          autoFocus
          aria-label="Search file names"
          placeholder="Find a file by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="editor-quick-results">
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {files.map((path, i) => (
            <button
              className={i === selected ? "selected" : ""}
              key={path}
              onClick={() => onOpen(path)}
            >
              <FileIcon size={14} />
              {path}
            </button>
          ))}
          {files.length === 0 && <p className="dim">No matching files.</p>}
        </div>
      </div>
    </div>
  );
}
