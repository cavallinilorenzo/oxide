// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { open } from "@tauri-apps/plugin-dialog";
import { ProjectPalette } from "./ProjectPalette";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
  clearMocks();
  vi.useRealTimers();
});

const projects = [
  { id: 1, name: "oxide", path: "/code/oxide", hidden: false, open: true, missing: false },
  { id: 2, name: "uni", path: "/code/uni", hidden: false, open: false, missing: false },
];

it("starts a Thread in the clicked Project rather than the keyboard-highlighted Project", () => {
  const onStartThread = vi.fn();
  const onClose = vi.fn();
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={onStartThread} onOpenProject={() => {}} onClose={onClose} />));
  const secondProject = container.querySelectorAll<HTMLElement>('[role="option"]')[1];
  act(() => secondProject.querySelector<HTMLElement>(".palette-name")!.click());
  expect(onStartThread).toHaveBeenCalledWith(projects[1]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("still starts the keyboard-selected Project with ArrowDown and Enter", () => {
  const onStartThread = vi.fn();
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={onStartThread} onOpenProject={() => {}} onClose={() => {}} />));
  const search = container.querySelector("input")!;
  act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onStartThread).toHaveBeenCalledWith(projects[1]);
});

it("updates the active row on pointer movement without moving focus from Search", () => {
  const onStartThread = vi.fn();
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={onStartThread} onOpenProject={() => {}} onClose={() => {}} />));
  const search = container.querySelector("input")!;
  const row = container.querySelectorAll<HTMLElement>('[role="option"]')[1];
  act(() => row.dispatchEvent(new Event("pointermove", { bubbles: true })));
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(search.getAttribute("aria-activedescendant")).toBe(row.id);
  const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  act(() => row.dispatchEvent(mouseDown));
  expect(mouseDown.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(search);
  act(() => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onStartThread).toHaveBeenCalledWith(projects[1]);
});

it.each([
  ["Create a new Project (git init)", "Project name"],
  ["Clone a repository from a Git URL", "Git URL"],
])("opens the clicked action %s independently of the highlighted Project", (label, field) => {
  const onStartThread = vi.fn();
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={onStartThread} onOpenProject={() => {}} onClose={() => {}} />));
  const action = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find((row) => row.textContent === label)!;
  act(() => action.click());
  expect(container.querySelector("input")?.getAttribute("aria-label")).toBe(field);
  expect(onStartThread).not.toHaveBeenCalled();
});

it("opens the native folder picker and registers the chosen folder", async () => {
  vi.mocked(open).mockResolvedValueOnce("C:/projects/demo");
  const onOpenProject = vi.fn();
  const onClose = vi.fn();
  mockIPC((command, args) => {
    if (command === "add_project") {
      expect(args).toMatchObject({ path: "C:/projects/demo" });
      return projects[0];
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={() => {}} onOpenProject={onOpenProject} onClose={onClose} />));
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((row) => row.textContent === "Add a local folder as a Project")!.click();
  });
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
  expect(onOpenProject).toHaveBeenCalledWith(projects[0]);
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps the palette open when the folder picker is cancelled", async () => {
  vi.mocked(open).mockResolvedValueOnce(null);
  const onClose = vi.fn();
  act(() => root.render(<ProjectPalette projects={[]} defaultParent="/code"
    onStartThread={() => {}} onOpenProject={() => {}} onClose={onClose} />));
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((row) => row.textContent === "Add a local folder as a Project")!.click();
  });
  expect(onClose).not.toHaveBeenCalled();
  expect(container.querySelector('input')?.getAttribute('aria-label')).toBe('Search');
});

it("chooses the clicked GitHub repository rather than the first result", async () => {
  vi.useFakeTimers();
  mockIPC((command) => {
    if (command === "search_github_repositories") return [
      { nameWithOwner: "demo/oxide", description: "Desktop app", isPrivate: false },
      { nameWithOwner: "demo/uni", description: "Another Project", isPrivate: false },
    ];
    throw new Error(`Unexpected command: ${command}`);
  });
  act(() => root.render(<ProjectPalette projects={projects} defaultParent="/code"
    onStartThread={() => {}} onOpenProject={() => {}} onClose={() => {}} />));
  act(() => Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    .find((row) => row.textContent === "Clone one of your GitHub repositories")!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  act(() => container.querySelectorAll<HTMLElement>('[role="option"]')[1].click());
  expect(container.querySelector(".palette-title")?.textContent).toBe("Clone demo/uni");
  expect(container.querySelector("input")?.getAttribute("aria-label")).toBe("Parent folder");
});

it("keeps the active descendant valid when asynchronous results shrink", () => {
  const render = (items: typeof projects) => root.render(<ProjectPalette projects={items} defaultParent="/code"
    onStartThread={() => {}} onOpenProject={() => {}} onClose={() => {}} />);
  act(() => render(projects));
  act(() => container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  act(() => render([]));
  const active = container.querySelector('[role="option"][aria-selected="true"]')!;
  expect(active.textContent).toBe("Clone one of your GitHub repositories");
  expect(container.querySelector("input")?.getAttribute("aria-activedescendant")).toBe(active.id);
});
