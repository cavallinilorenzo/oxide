import type { ReactNode } from "react";
import { EyeIcon, GitBranchIcon, PencilIcon } from "@primer/octicons-react";
import type { Thread } from "./bindings";
import { ProviderAvatar } from "./ProviderAvatar";
import { UsageRing } from "./UsageRing";

interface ThreadHeaderProps {
  threadId: number | null;
  thread: Thread | null;
  title: string;
  provider: string;
  /** The Thread's Git controls: they replace the dispatch-time branch label with the live one. */
  gitControls?: ReactNode;
  reportsUsage: boolean;
  editing: boolean;
  editTitle: string;
  onEditTitleChange: (title: string) => void;
  onStartRename: () => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
}

/**
 * The banner at the top of a Thread: Provider avatar, title, branch and Git actions, usage ring.
 * The Model lives in the composer and the folder in the app header.
 */
export function ThreadHeader({
  threadId,
  thread,
  title,
  provider,
  gitControls,
  reportsUsage,
  editing,
  editTitle,
  onEditTitleChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
}: ThreadHeaderProps) {
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
            {thread?.blindReview && (
              <span className="chip" title="Blind review" aria-label="Blind review">
                <EyeIcon size={12} /> Blind review
              </span>
            )}
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
        {gitControls ? (
          <div className="thread-git">{gitControls}</div>
        ) : (
          thread?.worktreePath && thread.branch && (
            <span className="thread-folder-branch">
              <GitBranchIcon size={12} /> {thread.branch}
            </span>
          )
        )}
      </div>
      <UsageRing provider={provider} reportsUsage={reportsUsage} />
    </div>
  );
}
