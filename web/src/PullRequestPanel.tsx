import { useEffect, useState } from "react";
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

/** How often the open panel reloads from GitHub while the window is visible. */
export const REFRESH_INTERVAL_MS = 30_000;

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

/** A counter that changes whenever GitHub should be asked again: on window focus and on a timer
 *  that only runs while the window is visible. */
function useAutoRefresh(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, REFRESH_INTERVAL_MS);
    window.addEventListener("focus", bump);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", bump);
    };
  }, []);
  return tick;
}
