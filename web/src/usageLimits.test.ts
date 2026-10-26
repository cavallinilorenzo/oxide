import { describe, expect, it } from "vitest";
import type { UsageLimitWindow, UsageLimits } from "./bindings";
import { formatCountdown, usageView } from "./usageLimits";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const secs = (ms: number) => Math.floor(ms / 1000);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const win = (over: Partial<UsageLimitWindow> = {}): UsageLimitWindow => ({
  percentUsed: 42,
  resetsAt: secs(NOW + 2 * HOUR + 13 * MIN),
  status: "ok",
  reportedAt: secs(NOW - MIN),
  ...over,
});

const limits = (over: Partial<UsageLimits> = {}): UsageLimits => ({
  fiveHour: win(),
  weekly: win({ percentUsed: 10, resetsAt: secs(NOW + 3 * DAY + 4 * HOUR) }),
  ...over,
});

const ready = (view: ReturnType<typeof usageView>) => {
  if (view.kind !== "ready") throw new Error(`expected ready, got ${view.kind}`);
  return view;
};

describe("formatCountdown", () => {
  it("counts minutes, hours and days", () => {
    expect(formatCountdown(secs(NOW + 5 * MIN), NOW)).toBe("5 min");
    expect(formatCountdown(secs(NOW + 2 * HOUR + 13 * MIN), NOW)).toBe("2 h 13 min");
    expect(formatCountdown(secs(NOW + 2 * HOUR), NOW)).toBe("2 h");
    expect(formatCountdown(secs(NOW + 3 * DAY + 4 * HOUR), NOW)).toBe("3 d 4 h");
    expect(formatCountdown(secs(NOW + 3 * DAY), NOW)).toBe("3 d");
  });

  it("never shows less than a minute", () => {
    expect(formatCountdown(secs(NOW + 10_000), NOW)).toBe("1 min");
  });
});

describe("usageView", () => {
  it("is hidden for a Provider that reports no Usage limits", () => {
    expect(usageView(limits(), false, NOW).kind).toBe("hidden");
  });

  it("shows an empty state, not a fake 0%, before anything was reported", () => {
    expect(usageView(null, true, NOW)).toEqual({ kind: "empty", message: "No usage reported yet" });
    expect(usageView({ fiveHour: null, weekly: null }, true, NOW).kind).toBe("empty");
  });

  it("fills the ring with the 5-hour share and lists both windows", () => {
    const view = ready(usageView(limits(), true, NOW));
    expect(view.fraction).toBeCloseTo(0.42);
    expect(view.severity).toBe("normal");
    expect(view.rows).toEqual([
      {
        label: "5-hour limit",
        percentLabel: "42% used",
        resetLabel: "Resets in 2 h 13 min",
        ariaLabel: "5-hour limit 42% used, resets in 2 hours 13 minutes",
      },
      {
        label: "Weekly limit",
        percentLabel: "10% used",
        resetLabel: "Resets in 3 d 4 h",
        ariaLabel: "Weekly limit 10% used, resets in 3 days 4 hours",
      },
    ]);
  });

  it.each([
    [79, "normal"],
    [80, "warning"],
    [94, "warning"],
    [95, "critical"],
    [100, "critical"],
  ])("grades %i%% as %s", (percentUsed, severity) => {
    const view = ready(usageView(limits({ fiveHour: win({ percentUsed }) }), true, NOW));
    expect(view.severity).toBe(severity);
  });

  it("is critical whenever the Provider says the user is limited", () => {
    const view = ready(
      usageView(limits({ fiveHour: win({ percentUsed: 30, status: "limited" }) }), true, NOW),
    );
    expect(view.severity).toBe("critical");
  });

  it("shows a window past its reset time as reset, at 0%", () => {
    const stale = win({ percentUsed: 97, resetsAt: secs(NOW - MIN), status: "limited" });
    const view = ready(usageView(limits({ fiveHour: stale }), true, NOW));
    expect(view.fraction).toBe(0);
    expect(view.severity).toBe("normal");
    expect(view.rows[0]).toMatchObject({ percentLabel: "0% used", resetLabel: "Reset" });
  });

  it("keeps an unknown figure unknown", () => {
    const unknown = win({ percentUsed: null, status: "warning" });
    const view = ready(usageView(limits({ fiveHour: unknown }), true, NOW));
    expect(view.rows[0].percentLabel).toBe("Usage not reported");
    expect(view.fraction).toBe(0);
  });

  it("says so when a window was never reported", () => {
    const view = ready(usageView(limits({ weekly: null }), true, NOW));
    expect(view.rows[1]).toMatchObject({ label: "Weekly limit", percentLabel: "Not reported yet", resetLabel: "" });
  });

  it("ring is empty and normal when only the weekly window is known", () => {
    const view = ready(usageView(limits({ fiveHour: null }), true, NOW));
    expect(view.fraction).toBe(0);
    expect(view.rows[0].percentLabel).toBe("Not reported yet");
  });

  it("marks data from before this session with how long ago it was reported", () => {
    const earlier = win({ reportedAt: secs(NOW - 3 * HOUR) });
    const old = limits({ fiveHour: earlier, weekly: earlier });
    expect(ready(usageView(old, true, NOW, NOW - HOUR)).updatedLabel).toBe("Updated 3 h ago");
    expect(ready(usageView(limits(), true, NOW, NOW - HOUR)).updatedLabel).toBeNull();
  });
});
