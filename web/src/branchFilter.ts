import type { GitBranch } from "./bindings";

/** Branches whose name contains every whitespace-separated term, case-insensitively. */
export function filterBranches(branches: GitBranch[], query: string): GitBranch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return branches.filter((b) => terms.every((t) => b.name.toLowerCase().includes(t)));
}

/** Whether typing `query` offers to create a branch: non-empty and not an existing name. */
export function canCreateBranch(branches: GitBranch[], query: string): boolean {
  const name = query.trim();
  return name !== "" && !branches.some((b) => b.name === name);
}
