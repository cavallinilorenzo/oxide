import { useEffect, useState } from "react";
import { FileDirectoryIcon, GitBranchIcon, PencilIcon } from "@primer/octicons-react";
import { commands, type ModelInfo, type Thread } from "./bindings";
import { ProviderAvatar } from "./ProviderAvatar";
import { UsageRing } from "./UsageRing";
import { threadHeaderLines } from "./headerLines";

interface ThreadHeaderProps {
  threadId: number | null;
  thread: Thread | null;
  title: string;
  provider: string;
  model: string | null;
  effort: string | null;
  projectPath: string;
  reportsUsage: boolean;
  editing: boolean;
  editTitle: string;
  onEditTitleChange: (title: string) => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
}

/** The banner at the top of a Thread: Provider avatar, title, Model, folder and usage ring. */
export function ThreadHeader({
  threadId,
  thread,
  title,
  provider,
  model,
  effort,
  projectPath,
  reportsUsage,
  editing,
  editTitle,
  onEditTitleChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
}: ThreadHeaderProps) {
  const [catalog, setCatalog] = useState<{ provider: string; models: ModelInfo[] } | null>(null);
  useEffect(() => {
    let active = true;
    void commands.getModelCatalog(provider, false).then((res) => {
      if (active && res.status === "ok") setCatalog({ provider, models: res.data });
    });
    return () => {
      active = false;
    };
  }, [provider]);

  const lines = threadHeaderLines({
    provider,
    model,
    effort,
    thread,
    projectPath,
    catalog: catalog?.provider === provider ? catalog.models : null,
  });

  return (
    <div className="thread-header-bar">
      <div className="thread-avatar">
        <ProviderAvatar provider={provider} />
        {thread && <span className={`status-dot ${thread.status}`} role="img" aria-label={`Status: ${thread.status}`} />}
      </div>
      <div className="thread-header-text">
        {editing ? (
          <input
            className="thread-title-input"
            value={editTitle}
            onChange={(e) => onEditTitleChange(e.target.value)}
            onBlur={onSaveRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveRename();
              if (e.key === "Escape") onCancelRename();
            }}
            autoFocus
            aria-label="Rename thread title"
          />
        ) : (
          <div className="thread-title-display">
            <h2 className="thread-title" onClick={onStartRename} title={`${title} · Click to rename`}>
              {title}
            </h2>
            {thread?.issueNumber != null && (
              <span className="chip" title={`Started from issue #${thread.issueNumber}`}>
                #{thread.issueNumber}
              </span>
            )}
            {threadId && (
              <button
                type="button"
                className="icon-btn sm rename-thread-btn"
                aria-label="Rename thread"
                title="Rename thread"
                onClick={onStartRename}
              >
                <PencilIcon size={12} />
              </button>
            )}
          </div>
        )}
        <div className="thread-meta-line">{lines.modelLine}</div>
        <div className="thread-folder-line" title={lines.folder.path}>
          <FileDirectoryIcon size={12} />
          <span className="thread-folder-path">{lines.folder.text}</span>
          {lines.folder.branch && (
            <span className="thread-folder-branch">
              <GitBranchIcon size={12} /> {lines.folder.branch}
            </span>
          )}
        </div>
      </div>
      <div className="thread-header-actions">
        <UsageRing provider={provider} reportsUsage={reportsUsage} />
      </div>
    </div>
  );
}
