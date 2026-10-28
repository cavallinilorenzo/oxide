import { PullRequestBrowser } from "./PullRequestBrowser";
import { REFRESH_INTERVAL_MS, useAutoRefresh } from "./useAutoRefresh";

export { REFRESH_INTERVAL_MS };

interface PullRequestPanelProps {
  projectId: number;
  createRequest?: number;
  onCreateHandled?: () => void;
  /** Changes after the user's own Git changes (commit, push, pull, checkout), which refresh the panel. */
  refreshKey: number;
  /** Called after a pull request was created, merged or checked out, so other Git views reload. */
  onChanged: () => void;
  /** Shows a pull request's changed files in the Diff Surface. */
  onReviewFiles: (number: number) => void;
}

/** The repository's open pull requests on GitHub, through `gh`. It loads when opened, after the
 *  user's own Git changes, when the window regains focus, and periodically while visible.
 *  State belongs to one Project, so a different one remounts it. */
export function PullRequestPanel(props: PullRequestPanelProps) {
  return <PullRequestViews key={props.projectId} {...props} />;
}

function PullRequestViews(props: PullRequestPanelProps) {
  const tick = useAutoRefresh();
  return (
    <div className="pr-views">
      <section className="pr-panel pr-panel-flush" aria-label="Pull requests">
        <PullRequestBrowser {...props} refreshKey={props.refreshKey + tick} />
      </section>
    </div>
  );
}
