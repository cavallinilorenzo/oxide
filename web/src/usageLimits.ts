import type { UsageLimitWindow, UsageLimits } from "./bindings";

export type UsageSeverity = "normal" | "warning" | "critical";

/** One window's ring and what hovering it says. */
export interface UsageWindowView {
  key: "five-hour" | "weekly";
  /** The short name shown next to the ring. */
  label: string;
  /** The full name, for the tooltip heading. */
  title: string;
  /** Share used, 0 to 1. */
  fraction: number;
  severity: UsageSeverity;
  /** Shown beside the ring: "2 h 13 min", "Reset", or "—" when unknown. */
  countdown: string;
  /** The tooltip: exact percentage and reset time. */
  detail: string;
  ariaLabel: string;
}

export type UsageView =
  | { kind: "hidden" }
  | {
      kind: "ready";
      /** The 5-hour window, then the weekly one; a window never reported is empty. */
      windows: UsageWindowView[];
      /** "Updated 3 h ago" when the figures predate this session. */
      updatedLabel: string | null;
    };

const WARNING_AT = 80;
const CRITICAL_AT = 95;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function split(seconds: number): { days: number; hours: number; minutes: number } {
  const total = Math.max(seconds, 0);
  return {
    days: Math.floor(total / DAY),
    hours: Math.floor((total % DAY) / HOUR),
    minutes: Math.floor((total % HOUR) / MINUTE),
  };
}

/** "5 min", "2 h 13 min", "3 d 4 h": two units at most, never less than a minute. */
function duration(seconds: number, long: boolean): string {
  const { days, hours, minutes } = split(seconds);
  const unit = (n: number, short: string, one: string) =>
    long ? `${n} ${n === 1 ? one : `${one}s`}` : `${n} ${short}`;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(unit(days, "d", "day"));
    if (hours > 0) parts.push(unit(hours, "h", "hour"));
  } else if (hours > 0) {
    parts.push(unit(hours, "h", "hour"));
    if (minutes > 0) parts.push(unit(minutes, "min", "minute"));
  } else {
    parts.push(unit(Math.max(minutes, 1), "min", "minute"));
  }
  return parts.join(" ");
}

/** How long until `resetsAt` (epoch seconds), e.g. "2 h 13 min". */
export function formatCountdown(resetsAt: number, nowMs: number): string {
  return duration(resetsAt - nowMs / 1000, false);
}

/** "42%" or "42.5%": exact, without trailing zeros. */
function percentText(percent: number): string {
  return `${Number(percent.toFixed(1))}%`;
}

interface Resolved {
  percent: number | null;
  severity: UsageSeverity;
  percentLabel: string;
  resetLabel: string;
  resetAria: string;
  countdown: string;
}

function resolve(window: UsageLimitWindow, nowMs: number): Resolved {
  const hasReset = window.resetsAt != null;
  if (hasReset && window.resetsAt! * 1000 <= nowMs) {
    // Reset since the last report: the old pressure is gone until the Provider reports again.
    return {
      percent: 0,
      severity: "normal",
      percentLabel: "0% used",
      resetLabel: "Reset",
      resetAria: "reset",
      countdown: "Reset",
    };
  }
  const percent = window.percentUsed == null ? null : Math.min(Math.max(window.percentUsed, 0), 100);
  const severity: UsageSeverity =
    window.status === "limited" || (percent ?? 0) >= CRITICAL_AT
      ? "critical"
      : (percent ?? 0) >= WARNING_AT || window.status === "warning"
        ? "warning"
        : "normal";
  return {
    percent,
    severity,
    percentLabel: percent == null ? "Usage not reported" : `${percentText(percent)} used`,
    resetLabel: hasReset ? `Resets in ${formatCountdown(window.resetsAt!, nowMs)}` : "",
    resetAria: hasReset ? `resets in ${duration(window.resetsAt! - nowMs / 1000, true)}` : "",
    countdown: hasReset ? formatCountdown(window.resetsAt!, nowMs) : "—",
  };
}

function windowView(
  key: UsageWindowView["key"],
  label: string,
  title: string,
  window: UsageLimitWindow | null | undefined,
  nowMs: number,
): UsageWindowView {
  if (!window) {
    return {
      key,
      label,
      title,
      fraction: 0,
      severity: "normal",
      countdown: "—",
      detail: "No usage reported yet",
      ariaLabel: `${title} not reported yet`,
    };
  }
  const r = resolve(window, nowMs);
  return {
    key,
    label,
    title,
    fraction: (r.percent ?? 0) / 100,
    severity: r.severity,
    countdown: r.countdown,
    detail: [r.percentLabel, r.resetLabel].filter(Boolean).join(" · "),
    ariaLabel: [`${title} ${r.percentLabel}`, r.resetAria].filter(Boolean).join(", "),
  };
}

/**
 * What the usage rings show. `sessionStartMs` marks the start of this run of Oxide: figures
 * reported before it are labelled with their age.
 */
export function usageView(
  limits: UsageLimits | null,
  reportsUsage: boolean,
  nowMs: number,
  sessionStartMs: number = nowMs,
): UsageView {
  if (!reportsUsage) return { kind: "hidden" };
  const newest = Math.max(limits?.fiveHour?.reportedAt ?? 0, limits?.weekly?.reportedAt ?? 0) * 1000;
  return {
    kind: "ready",
    windows: [
      windowView("five-hour", "5h", "5-hour limit", limits?.fiveHour, nowMs),
      windowView("weekly", "Weekly", "Weekly limit", limits?.weekly, nowMs),
    ],
    updatedLabel:
      newest > 0 && newest < sessionStartMs ? `Updated ${duration((nowMs - newest) / 1000, false)} ago` : null,
  };
}
