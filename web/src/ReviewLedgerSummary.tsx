import { useCallback, useEffect, useState } from "react";
import { commands, type ReviewLedger, type ReviewWorkKind } from "./bindings";

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

/** The kind of work in a group, as one readable line. */
export function formatWorkKind(kind: ReviewWorkKind): string {
  const languages = kind.languages.length > 0 ? kind.languages.join(", ") : "no language";
  const parts = [`${languages} · ${kind.sizeBand} change`];
  if (kind.issueLabels.length > 0) parts.push(`labels: ${kind.issueLabels.join(", ")}`);
  return parts.join(" · ");
}

/**
 * The Review ledger of a Project: the median wait between a Thread's last completed Turn and
 * its merge, and how many review rounds each Provider and Model needed, by kind of work. Local
 * figures only; the user can clear them. Each round group shows its sample size.
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

  async function handleConfirmFollowUp(pullRequest: number, commitSha: string) {
    const result = await commands.confirmFollowUp(projectId, pullRequest, commitSha);
    if (result.status === "ok") {
      await load();
    } else {
      setError(result.error.message);
    }
  }

  async function handleDismissFollowUp(pullRequest: number, commitSha: string) {
    const result = await commands.dismissFollowUp(projectId, pullRequest, commitSha);
    if (result.status === "ok") {
      await load();
    } else {
      setError(result.error.message);
    }
  }

  const merges = ledger?.count ?? 0;
  const rounds = ledger?.rounds ?? [];
  const reverts = ledger?.reverts ?? [];
  const followUps = ledger?.followUps ?? [];
  const empty =
    ledger === null ||
    (merges === 0 && rounds.length === 0 && reverts.length === 0 && followUps.length === 0);
  return (
    <section className="review-ledger" aria-label="Review ledger">
      <h2>Time to merge</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {merges === 0 ? (
        <p className="dim">
          No merged pull requests yet. Oxide records how long finished work waits for its merge,
          here on this machine only.
        </p>
      ) : (
        <>
          <p>
            Median wait from a finished Turn to the merge:{" "}
            <strong>{formatWait(ledger?.medianSecs ?? 0)}</strong>{" "}
            <span className="dim">({merges} merged)</span>
          </p>
          <ul>
            {(ledger?.entries ?? []).map((entry) => (
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
        </>
      )}
      <h2>Reverts and follow-up fixes</h2>
      {reverts.length === 0 && followUps.length === 0 ? (
        <p className="dim">
          No reverts or follow-up fixes detected within 30 days of merged pull requests.
        </p>
      ) : (
        <>
          {reverts.length > 0 && (
            <div className="review-reverts">
              <h3>Reverts</h3>
              <ul>
                {reverts.map((rev) => (
                  <li key={`revert-${rev.pullRequest}-${rev.commitSha}`}>
                    <span>
                      <strong>#{rev.pullRequest}</strong> revert
                    </span>
                    <span className="commit-subject">{rev.commitSubject}</span>
                    {rev.committedAt && (
                      <time className="dim" dateTime={new Date(rev.committedAt * 1000).toISOString()}>
                        {new Date(rev.committedAt * 1000).toLocaleDateString([], {
                          day: "numeric",
                          month: "short",
                        })}
                      </time>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {followUps.length > 0 && (
            <div className="review-follow-ups">
              <h3>Follow-up fixes</h3>
              <p className="dim">
                Candidates are unverified follow-up fixes detected from co-modified files.
              </p>
              <ul>
                {followUps.map((fu) => (
                  <li key={`followup-${fu.pullRequest}-${fu.commitSha}`}>
                    <span>
                      <strong>#{fu.pullRequest}</strong>
                    </span>
                    <span className="commit-subject">{fu.commitSubject}</span>
                    <span className="dim">
                      {fu.coModifiedFiles.length > 0
                        ? `modified ${fu.coModifiedFiles.join(", ")}`
                        : ""}
                    </span>
                    <span className="badge">{fu.status}</span>
                    {fu.status === "candidate" ? (
                      <span className="actions">
                        <button
                          className="btn"
                          onClick={() => void handleConfirmFollowUp(fu.pullRequest, fu.commitSha)}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn"
                          onClick={() => void handleDismissFollowUp(fu.pullRequest, fu.commitSha)}
                        >
                          Dismiss
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <h2>Review rounds</h2>
      {rounds.length === 0 ? (
        <p className="dim">
          No review rounds yet. Oxide counts each send of Line comments or reviewer comments,
          here on this machine only.
        </p>
      ) : (
        <>
          <p className="dim">
            How many review rounds each Provider and Model needed, by kind of work. Each group
            shows its sample size, so a small group is not read as strong evidence.
          </p>
          <ul className="review-rounds" aria-label="Review rounds by Provider">
            {rounds.map((group) => (
              <li
                key={`${group.provider}-${group.model ?? ""}-${JSON.stringify(group.kind)}`}
                data-sample-size={group.sampleSize}
              >
                <span>
                  <strong>{group.provider}</strong>
                  {group.model ? ` · ${group.model}` : ""}
                </span>
                <span className="dim">{formatWorkKind(group.kind)}</span>
                <span className="dim">
                  sample size: {group.sampleSize} {group.sampleSize === 1 ? "round" : "rounds"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!empty &&
        (confirming ? (
          <p role="group" aria-label="Confirm clearing the Review ledger">
            Remove the Review ledger, with the comments kept for rule suggestions, for every
            Project? This cannot be undone.{" "}
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
        ))}
    </section>
  );
}
