import { useId } from "react";
import { usageView, type UsageSeverity, type UsageWindowView } from "./usageLimits";
import { SESSION_START_MS, useNow, useUsageLimits } from "./useUsageLimits";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const STROKE: Record<UsageSeverity, string> = {
  normal: "var(--acc)",
  warning: "var(--yellow)",
  critical: "var(--red)",
};

function Ring({ window, updatedLabel }: { window: UsageWindowView; updatedLabel: string | null }) {
  const tooltipId = useId();
  return (
    <div className="usage-item">
      <button type="button" className="usage-btn" aria-label={window.ariaLabel} aria-describedby={tooltipId}>
        <span className="usage-label">{window.label}</span>
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
            stroke={STROKE[window.severity]}
            strokeDasharray={`${window.fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
        <span className="usage-countdown">{window.countdown}</span>
      </button>
      <div className="usage-popover" id={tooltipId} role="tooltip">
        <strong className="usage-title">{window.title}</strong>
        <p className="usage-detail">{window.detail}</p>
        {updatedLabel && <p className="usage-updated">{updatedLabel}</p>}
      </div>
    </div>
  );
}

/**
 * The Provider's 5-hour and weekly Usage limits, each as a labelled ring with the time left until
 * it resets; hovering a ring gives the exact percentage. Hidden for a Provider that reports no
 * Usage limits.
 */
export function UsageRing({ provider, reportsUsage }: { provider: string; reportsUsage: boolean }) {
  const limits = useUsageLimits(provider, reportsUsage);
  const now = useNow();
  const view = usageView(limits, reportsUsage, now, SESSION_START_MS);
  if (view.kind === "hidden") return null;
  return (
    <div className="usage-rings">
      {view.windows.map((window) => (
        <Ring key={window.key} window={window} updatedLabel={view.updatedLabel} />
      ))}
    </div>
  );
}
