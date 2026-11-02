import { useCallback, useEffect, useState } from "react";
import { commands, type ReviewLedger } from "./bindings";

/** "42 min", "3 h 5 min", "2 d 4 h": the two largest units, nothing below a minute. */
export function formatWait(secs: number): string {
  const minutes = Math.round(secs / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/**
 * The Review ledger of a Project: the median wait between a Thread's last completed Turn and
 * its merge, and the recent merges. Local figures only; the user can clear them.
 */
export function ReviewLedgerSummary({ projectId }: { projectId: number }) {
  const [ledger, setLedger] = useState<ReviewLedger | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await commands.reviewLedger(projectId);
    if (result.status === "ok") setLedger(result.data);
    else setError(result.error.message);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void commands.reviewLedger(projectId).then((result) => {
      if (!active) return;
      if (result.status === "ok") setLedger(result.data);
      else setError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  async function clear() {
    const result = await commands.clearReviewLedger();
    setConfirming(false);
    if (result.status === "ok") {
      setError(null);
      await load();
    } else setError(result.error.message);
  }

  const empty = !ledger || ledger.count === 0;
  return (
    <section className="review-ledger" aria-label="Review ledger">
      <h2>Time to merge</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {empty ? (
        <p className="dim">
          No merged pull requests yet. Oxide records how long finished work waits for its merge,
          here on this machine only.
        </p>
      ) : (
        <>
          <p>
            Median wait from a finished Turn to the merge:{" "}
            <strong>{formatWait(ledger.medianSecs ?? 0)}</strong>{" "}
            <span className="dim">({ledger.count} merged)</span>
          </p>
          <ul>
            {ledger.entries.map((entry) => (
              <li key={`${entry.projectId}-${entry.pullRequest}`}>
                <span>#{entry.pullRequest}</span>
                <span className="dim">
                  {entry.provider}
                  {entry.model ? ` · ${entry.model}` : ""}
                </span>
                <span>
                  {formatWait(Math.max(0, (entry.mergedAt ?? 0) - (entry.turnCompletedAt ?? 0)))}
                </span>
                <time className="dim" dateTime={new Date((entry.mergedAt ?? 0) * 1000).toISOString()}>
                  {new Date((entry.mergedAt ?? 0) * 1000).toLocaleDateString([], {
                    day: "numeric",
                    month: "short",
                  })}
                </time>
              </li>
            ))}
          </ul>
          {confirming ? (
            <p role="group" aria-label="Confirm clearing the Review ledger">
              Remove the Review ledger of every Project? This cannot be undone.{" "}
              <button className="btn danger" onClick={() => void clear()}>
                Remove ledger
              </button>{" "}
              <button className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </p>
          ) : (
            <button className="btn" onClick={() => setConfirming(true)}>
              Clear ledger…
            </button>
          )}
        </>
      )}
    </section>
  );
}
