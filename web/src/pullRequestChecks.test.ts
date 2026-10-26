import { describe, expect, it } from "vitest";
import { dedupeChecks, readiness, relativeTime } from "./pullRequestReview";

describe("dedupeChecks", () => {
  it("keeps the worst state per name and lists failures first", () => {
    const out = dedupeChecks([
      { name: "rust", state: "success" },
      { name: "web", state: "success" },
      { name: "rust", state: "pending" },
      { name: "lint", state: "failure" },
    ]);
    expect(out).toEqual([
      { name: "lint", state: "failure" },
      { name: "rust", state: "pending" },
      { name: "web", state: "success" },
    ]);
  });
});

describe("readiness", () => {
  it("blocks on draft, then failures, then running checks", () => {
    expect(readiness([], true).tone).toBe("neutral");
    expect(readiness([{ name: "a", state: "failure" }], false).label).toBe("1 check failing");
    expect(
      readiness(
        [
          { name: "a", state: "pending" },
          { name: "a", state: "success" },
        ],
        false,
      ).tone,
    ).toBe("warn");
    expect(readiness([{ name: "a", state: "success" }], false)).toEqual({ tone: "ok", label: "All checks passed" });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  it("picks the largest fitting unit", () => {
    expect(relativeTime("2026-10-26T11:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-10-26T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-10-26T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-10-24T12:00:00Z", now)).toBe("2d");
    expect(relativeTime("garbage", now)).toBe("");
  });
});
