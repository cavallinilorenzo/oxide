import { useId } from "react";
import { usageView, type UsageSeverity } from "./usageLimits";
import { SESSION_START_MS, useNow, useUsageLimits } from "./useUsageLimits";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const STROKE: Record<UsageSeverity, string> = {
  normal: "var(--acc)",
  warning: "var(--yellow)",
  critical: "var(--red)",
};

/**
 * A small ring showing how much of the Provider's 5-hour usage limit is used. Hovering or
 * focusing it opens a popover with the 5-hour and weekly limits. Hidden for a Provider that
 * reports no Usage limits.
 */
export function UsageRing({ provider, reportsUsage }: { provider: string; reportsUsage: boolean }) {
  const limits = useUsageLimits(provider, reportsUsage);
  const now = useNow();
  const popoverId = useId();
  const view = usageView(limits, reportsUsage, now, SESSION_START_MS);
  if (view.kind === "hidden") return null;

  const summary =
    view.kind === "ready" ? view.rows[0].ariaLabel : `Usage limits: ${view.message}`;
  const fraction = view.kind === "ready" ? view.fraction : 0;
  const severity = view.kind === "ready" ? view.severity : "normal";

  return (
    <div className="usage-ring">
      <button type="button" className="icon-btn sm usage-ring-btn" aria-label={summary} aria-describedby={popoverId}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="usage-ring-track" cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2.5" />
          <circle
            className="usage-ring-fill"
            cx="9"
            cy="9"
            r={RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke={STROKE[severity]}
            strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      <div className="usage-popover" id={popoverId} role="tooltip">
        {view.kind === "empty" ? (
          <p className="usage-empty">{view.message}</p>
        ) : (
          <>
            {view.rows.map((row) => (
              <div className="usage-row" key={row.label}>
                <span className="usage-row-label">{row.label}</span>
                <span className="usage-row-value">
                  {row.percentLabel}
                  {row.resetLabel && ` · ${row.resetLabel}`}
                </span>
              </div>
            ))}
            {view.updatedLabel && <p className="usage-updated">{view.updatedLabel}</p>}
          </>
        )}
      </div>
    </div>
  );
}
