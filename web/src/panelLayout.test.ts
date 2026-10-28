import { expect, it } from "vitest";
import { fileTreeLayout, workspaceLayout } from "./panelLayout";

it("reserves a readable Thread with both panels visible at every supported width", () => {
  for (const width of [1064, 1280, 1920]) {
    for (const sidebar of [null, 208, 400, 9000]) {
      for (const tools of [null, 496, 800, 9000]) {
        const layout = workspaceLayout(width, 516, { sidebar, tools, terminal: 9000 }, true);
        expect(width - layout.sidebar.value - layout.tools.value).toBeGreaterThanOrEqual(360);
        for (const panel of Object.values(layout)) {
          expect(panel.value).toBeGreaterThanOrEqual(panel.min);
          expect(panel.value).toBeLessThanOrEqual(panel.max);
        }
        expect(516 - layout.terminal.value).toBeGreaterThanOrEqual(280);
      }
    }
  }
});

it("restores preferred wide-window dimensions after a temporary narrow fit", () => {
  const preferred = { sidebar: 400, tools: 800, terminal: 500 };
  const narrow = workspaceLayout(1064, 516, preferred, true);
  expect(narrow.sidebar.value).toBe(208);
  expect(narrow.tools.value).toBe(496);
  expect(narrow.terminal.value).toBe(236);
  const wide = workspaceLayout(1920, 1000, preferred, true);
  expect(wide.sidebar.value).toBe(400);
  expect(wide.tools.value).toBe(800);
  expect(wide.terminal.value).toBe(500);
  expect(preferred).toEqual({ sidebar: 400, tools: 800, terminal: 500 });
});

it("does not reserve hidden Tools space in Settings or a focused workspace", () => {
  const preferred = { sidebar: 400, tools: 800, terminal: null };
  const layout = workspaceLayout(1064, 516, preferred, false);
  expect(layout.sidebar.value).toBe(400);
  expect(layout.sidebar.max).toBe(400);
  expect(workspaceLayout(1064, 516, preferred, true).sidebar.value).toBe(208);
});

it("keeps independent file tree dimensions when orientation changes", () => {
  const preferred = { width: 250, height: 180 };
  expect(fileTreeLayout(700, 756, preferred)).toMatchObject({ axis: "x", value: 250 });
  expect(fileTreeLayout(560, 756, preferred)).toMatchObject({ axis: "y", value: 180 });
  expect(fileTreeLayout(700, 756, preferred)).toMatchObject({ axis: "x", value: 250 });
});

it("keeps room for the file viewer at both file tree limits", () => {
  const columns = fileTreeLayout(600, 476, { width: 9000, height: null });
  expect(600 - columns.value).toBeGreaterThanOrEqual(200);
  const rows = fileTreeLayout(288, 476, { width: null, height: 9000 });
  expect(476 - rows.value).toBeGreaterThanOrEqual(120);
});
