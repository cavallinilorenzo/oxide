import { useCallback, useState } from "react";
import { SyncIcon } from "@primer/octicons-react";
import { PullRequestBrowser } from "./PullRequestBrowser";

interface PullRequestPanelProps {
  projectId: number;
  /** Changes after the user's own Git changes (commit, push, pull, checkout), which refresh the panel. */
  refreshKey: number;
  /** Called after a pull request was created, merged or checked out, so other Git views reload. */
  onChanged: () => void;
  /** Shows a pull request's changed files in the Diff Surface. */
  onReviewFiles: (number: number) => void;
}

/** The repository's open pull requests on GitHub, through `gh`. It loads when opened and
 *  after the user's own Git changes or a manual refresh; it never polls.
 *  State belongs to one Project, so a different one remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestViews key={props.projectId} {...props} />;
}

function PullRequestViews(props: PullRequestPanelProps) {
  // Bumped by the Refresh button: the only reload besides opening and the user's own changes.
  const [manual, setManual] = useState(0);
  const refresh = useCallback(() => setManual((n) => n + 1), []);
  return (
    <div className="pr-views">
      <div className="surface-bar">
        <span className="grow" />
        <button className="icon-btn sm" onClick={refresh} title="Reload from GitHub" aria-label="Reload from GitHub">
          <SyncIcon size={14} />
        </button>
      </div>
      <section className="pr-panel pr-panel-flush" aria-label="Pull requests">
        <PullRequestBrowser {...props} refreshKey={props.refreshKey + manual} />
      </section>
    </div>
  );
}
