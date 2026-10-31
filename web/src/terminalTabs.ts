/** A Project's terminal tabs. Each tab keeps the checkout it was opened in. */
export interface TerminalCheckout {
  /** Identifies the checkout: one per Board worktree, one for the main checkout. */
  key: string;
  /** `null` for the Project's main checkout. */
  threadId: number | null;
  rootPath: string;
}

export interface TerminalTab extends TerminalCheckout {
  id: number;
  /** The command a Command block is running now, if any. */
  running: string | null;
}

export interface ProjectTerminals {
  tabs: TerminalTab[];
  selectedId: number | null;
  nextId: number;
}

export type TerminalsByProject = Record<number, ProjectTerminals>;

export const emptyTerminals: ProjectTerminals = { tabs: [], selectedId: null, nextId: 1 };

const of = (state: TerminalsByProject, projectId: number) => state[projectId] ?? emptyTerminals;

/** Opens a tab in `checkout` and selects it. Only an explicit user action calls this. */
export function openTab(state: TerminalsByProject, projectId: number, checkout: TerminalCheckout): TerminalsByProject {
  const project = of(state, projectId);
  const tab: TerminalTab = { ...checkout, id: project.nextId, running: null };
  return { ...state, [projectId]: { tabs: [...project.tabs, tab], selectedId: tab.id, nextId: project.nextId + 1 } };
}

export function selectTab(state: TerminalsByProject, projectId: number, tabId: number): TerminalsByProject {
  const project = of(state, projectId);
  if (!project.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, [projectId]: { ...project, selectedId: tabId } };
}

/** Closing the selected tab selects its neighbour; other tabs never change. */
export function closeTab(state: TerminalsByProject, projectId: number, tabId: number): TerminalsByProject {
  const project = of(state, projectId);
  const index = project.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return state;
  const tabs = project.tabs.filter((tab) => tab.id !== tabId);
  const selectedId = project.selectedId !== tabId ? project.selectedId : (tabs[index] ?? tabs[index - 1])?.id ?? null;
  return { ...state, [projectId]: { ...project, tabs, selectedId } };
}

export function setRunning(state: TerminalsByProject, projectId: number, tabId: number, running: string | null): TerminalsByProject {
  const project = of(state, projectId);
  const tab = project.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.running === running) return state;
  return { ...state, [projectId]: { ...project, tabs: project.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, running } : candidate) } };
}

/** The tabs a Board Thread's worktree owns: what deleting that Thread closes. */
export function tabsOfThread(state: TerminalsByProject, projectId: number, threadId: number): TerminalTab[] {
  return of(state, projectId).tabs.filter((tab) => tab.threadId === threadId);
}

/** Drops the tabs of a deleted Board Thread's worktree and leaves every sibling alone. */
export function removeThreadTabs(state: TerminalsByProject, projectId: number, threadId: number): TerminalsByProject {
  return tabsOfThread(state, projectId, threadId).reduce((next, tab) => closeTab(next, projectId, tab.id), state);
}

/** A tab outside the selected Thread's checkout is flagged; with no selection nothing is. */
export function isMismatched(tab: TerminalTab, selected: TerminalCheckout | null): boolean {
  return selected !== null && tab.key !== selected.key;
}

/** What the delete confirmation says about the shells that deleting a worktree closes. */
export function describeAffectedTabs(tabs: TerminalTab[]): string[] {
  return tabs.map((tab) => tab.running ? `Running “${tab.running}” in ${tab.rootPath}` : `Idle shell in ${tab.rootPath}`);
}
