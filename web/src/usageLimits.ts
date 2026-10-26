import type { UsageLimitWindow, UsageLimits } from "./bindings";

export type UsageSeverity = "normal" | "warning" | "critical";

export interface UsageRow {
  label: string;
  percentLabel: string;
  /** "Resets in 2 h 13 min", "Reset", or empty when there is no reset time. */
  resetLabel: string;
  ariaLabel: string;
}

export type UsageView =
  | { kind: "hidden" }
  | { kind: "empty"; message: string }
  | {
      kind: "ready";
      /** Share of the 5-hour limit used, 0 to 1. */
      fraction: number;
      severity: UsageSeverity;
      rows: UsageRow[];
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
  const unit = (n: number, short: string, one: string) => (long ? `${n} ${n === 1 ? one : `${one}s`}` : `${n} ${short}`);
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

interface Resolved {
  percent: number | null;
  severity: UsageSeverity;
  percentLabel: string;
  resetLabel: string;
  resetAria: string;
}

function resolve(window: UsageLimitWindow, nowMs: number): Resolved {
  const hasReset = window.resetsAt != null;
  if (hasReset && window.resetsAt! * 1000 <= nowMs) {
    // Reset since the last report: the old pressure is gone until the Provider reports again.
    return { percent: 0, severity: "normal", percentLabel: "0% used", resetLabel: "Reset", resetAria: "reset" };
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
    percentLabel: percent == null ? "Usage not reported" : `${Math.round(percent)}% used`,
    resetLabel: hasReset ? `Resets in ${formatCountdown(window.resetsAt!, nowMs)}` : "",
    resetAria: hasReset ? `resets in ${duration(window.resetsAt! - nowMs / 1000, true)}` : "",
  };
}

function row(label: string, window: UsageLimitWindow | null | undefined, nowMs: number): UsageRow {
  if (!window) return { label, percentLabel: "Not reported yet", resetLabel: "", ariaLabel: `${label} not reported yet` };
  const r = resolve(window, nowMs);
  const aria = [`${label} ${r.percentLabel}`, r.resetAria].filter(Boolean).join(", ");
  return { label, percentLabel: r.percentLabel, resetLabel: r.resetLabel, ariaLabel: aria };
}

/**
 * What the usage ring and its popover show. `sessionStartMs` marks the start of this run of
 * Oxide: figures reported before it are labelled with their age.
 */
export function usageView(
  limits: UsageLimits | null,
  reportsUsage: boolean,
  nowMs: number,
  sessionStartMs: number = nowMs,
): UsageView {
  if (!reportsUsage) return { kind: "hidden" };
  if (!limits || (!limits.fiveHour && !limits.weekly)) {
    return { kind: "empty", message: "No usage reported yet" };
  }
  const five = limits.fiveHour ? resolve(limits.fiveHour, nowMs) : null;
  const newest = Math.max(limits.fiveHour?.reportedAt ?? 0, limits.weekly?.reportedAt ?? 0) * 1000;
  return {
    kind: "ready",
    fraction: (five?.percent ?? 0) / 100,
    severity: five?.severity ?? "normal",
    rows: [row("5-hour limit", limits.fiveHour, nowMs), row("Weekly limit", limits.weekly, nowMs)],
    updatedLabel: newest < sessionStartMs ? `Updated ${duration((nowMs - newest) / 1000, false)} ago` : null,
  };
}
