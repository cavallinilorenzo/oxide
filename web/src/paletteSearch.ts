import type { Project } from "./bindings";

export type PaletteActionId = "add-folder" | "new-project" | "clone-url" | "clone-github";

export const PALETTE_ACTIONS: { id: PaletteActionId; label: string }[] = [
  { id: "add-folder", label: "Add a local folder as a Project" },
  { id: "new-project", label: "Create a new Project (git init)" },
  { id: "clone-url", label: "Clone a repository from a Git URL" },
  { id: "clone-github", label: "Clone one of your GitHub repositories" },
];

/** Lower is better; `null` when `query` is not found. Prefix, then substring, then letters in order. */
function score(text: string, query: string): number | null {
  const haystack = text.toLowerCase();
  if (haystack.startsWith(query)) return 0;
  if (haystack.includes(query)) return 1;
  let from = 0;
  for (const ch of query) {
    const at = haystack.indexOf(ch, from);
    if (at < 0) return null;
    from = at + 1;
  }
  return 2;
}

/** Visible, present Projects matching `query`, best matches first (name before path). */
export function matchProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  const candidates = projects.filter((p) => !p.hidden && !p.missing);
  if (q === "") return candidates;
  return candidates
    .map((project, index) => {
      const byName = score(project.name, q);
      const byPath = score(project.path, q);
      const rank = byName ?? (byPath === null ? null : 10 + byPath);
      return { project, rank, index };
    })
    .filter((m): m is { project: Project; rank: number; index: number } => m.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((m) => m.project);
}

export function matchActions(query: string) {
  const q = query.trim().toLowerCase();
  if (q === "") return PALETTE_ACTIONS;
  return PALETTE_ACTIONS.filter((a) => score(a.label, q) !== null);
}

/** The highlighted row after ↑/↓, wrapping at both ends. */
export function moveHighlight(current: number, count: number, delta: 1 | -1): number {
  if (count === 0) return 0;
  return (current + delta + count) % count;
}
