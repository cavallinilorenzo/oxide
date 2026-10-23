import { describe, expect, it } from "vitest";
import type { GitBranch } from "./bindings";
import { canCreateBranch, filterBranches } from "./branchFilter";

const branches: GitBranch[] = [
  { name: "main", remote: false, current: true },
  { name: "feat/login", remote: false, current: false },
  { name: "origin/feat/signup", remote: true, current: false },
];

describe("filterBranches", () => {
  it("returns everything for a blank query", () => {
    expect(filterBranches(branches, "  ")).toEqual(branches);
  });

  it("matches case-insensitively on every term", () => {
    expect(filterBranches(branches, "FEAT sign").map((b) => b.name)).toEqual(["origin/feat/signup"]);
  });
});

describe("canCreateBranch", () => {
  it("offers creation only for a new, non-empty name", () => {
    expect(canCreateBranch(branches, "")).toBe(false);
    expect(canCreateBranch(branches, "main")).toBe(false);
    expect(canCreateBranch(branches, "fix/new")).toBe(true);
  });
});
