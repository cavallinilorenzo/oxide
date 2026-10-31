import { describe, expect, it } from "vitest";
import {
  closeTab, describeAffectedTabs, isMismatched, openTab, removeThreadTabs, selectTab, setRunning, tabsOfThread,
  type TerminalCheckout, type TerminalsByProject,
} from "./terminalTabs";

const main: TerminalCheckout = { key: "1:main", threadId: null, rootPath: "/repo" };
const featureA: TerminalCheckout = { key: "1:5", threadId: 5, rootPath: "/repo-wt/a" };
const featureB: TerminalCheckout = { key: "1:6", threadId: 6, rootPath: "/repo-wt/b" };

const opened = (...checkouts: TerminalCheckout[]) =>
  checkouts.reduce<TerminalsByProject>((state, checkout) => openTab(state, 1, checkout), {});

describe("Project terminal tabs", () => {
  it("opens and selects a tab that keeps its checkout", () => {
    const state = opened(featureA, main);
    expect(state[1].tabs.map((tab) => tab.key)).toEqual(["1:5", "1:main"]);
    expect(state[1].selectedId).toBe(state[1].tabs[1].id);
  });

  it("keeps each Project's tabs apart", () => {
    const state = openTab(opened(main), 2, { key: "2:main", threadId: null, rootPath: "/other" });
    expect(state[1].tabs).toHaveLength(1);
    expect(state[2].tabs).toHaveLength(1);
  });

  it("ignores selecting an unknown tab", () => {
    const state = opened(main);
    expect(selectTab(state, 1, 99)).toBe(state);
  });

  it("selects the neighbour when the selected tab closes and leaves others alone", () => {
    let state = opened(main, featureA, featureB);
    const [first, second, third] = state[1].tabs.map((tab) => tab.id);
    state = selectTab(state, 1, second);
    state = closeTab(state, 1, second);
    expect(state[1].selectedId).toBe(third);
    state = closeTab(state, 1, first);
    expect(state[1].selectedId).toBe(third);
    state = closeTab(state, 1, third);
    expect(state[1].selectedId).toBeNull();
  });

  it("never reuses a closed tab's id", () => {
    let state = opened(main);
    const id = state[1].tabs[0].id;
    state = openTab(closeTab(state, 1, id), 1, main);
    expect(state[1].tabs[0].id).not.toBe(id);
  });

  it("flags only a tab outside the selected Thread's checkout", () => {
    const [tab] = opened(featureA)[1].tabs;
    expect(isMismatched(tab, featureA)).toBe(false);
    expect(isMismatched(tab, main)).toBe(true);
    expect(isMismatched(tab, null)).toBe(false);
  });

  it("removes only the deleted worktree's tabs, keeping main and sibling worktrees", () => {
    const state = removeThreadTabs(opened(main, featureA, featureB, featureA), 1, 5);
    expect(state[1].tabs.map((tab) => tab.key)).toEqual(["1:main", "1:6"]);
  });

  it("names the running commands that deleting a worktree would stop", () => {
    let state = opened(featureA, featureA);
    const [one] = state[1].tabs;
    state = setRunning(state, 1, one.id, "npm run dev");
    expect(describeAffectedTabs(tabsOfThread(state, 1, 5))).toEqual([
      "Running “npm run dev” in /repo-wt/a",
      "Idle shell in /repo-wt/a",
    ]);
  });
});
