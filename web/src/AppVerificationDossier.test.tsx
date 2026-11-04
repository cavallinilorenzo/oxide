// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { clearQueryCache } from "./queryCache";
import { App } from "./App";

vi.mock("./ThreadView", () => ({ ThreadView: () => <div /> }));
vi.mock("./GitHeader", () => ({ GitHeader: () => null }));
vi.mock("./QuitDialog", () => ({ QuitDialog: () => null }));
vi.mock("./FilesPanel", () => ({ FilesPanel: () => null }));
vi.mock("./TerminalPanel", () => ({ TerminalPanel: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} } });

let host: HTMLDivElement;
let root: Root;
const project = { id: 1, name: "Project", path: "/test", hidden: false, open: true, missing: false };
const thread = { id: 2, projectId: 1, title: "Existing", provider: "claude", status: "completed", updatedAt: "2026-01-01T00:00:00Z" };
const file = (path: string) => ({ path, oldPath: null, status: "modified", added: 1, removed: 0, binary: false, hunks: [] });
const calls: { command: string; args: unknown }[] = [];

beforeEach(() => {
  clearQueryCache();
  calls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "list_projects" || command === "rescan_projects") return [project];
    if (command === "last_selection") return { projectId: 1, threadId: 2 };
    if (command === "list_threads") return [thread];
    if (command === "list_turn_picks") return [{ turnIndex: 0, prompt: "Add the parser", checkpointed: true }];
    if (command === "git_turn_diff") return { base: null, files: [file("src/parser.rs")] };
    if (command === "git_diff") return { base: "main", files: [] };
    if (command === "verification_dossier") {
      return {
        commands: [
          { command: "cargo test", kind: "test", state: "fresh", turnIndex: 0, outcome: "succeeded", exitCode: 0 },
          { command: "cargo clippy", kind: "lint", state: "stale", turnIndex: 0, outcome: "succeeded", exitCode: 0 },
          { command: "pytest", kind: "test", state: "failed", turnIndex: 0, outcome: "failed", exitCode: 1 },
          { command: "pnpm run verify", kind: "other", state: "neverRun", turnIndex: null, outcome: null, exitCode: null },
          { command: "tsc", kind: "typeCheck", state: "unknown", turnIndex: 0, outcome: "succeeded", exitCode: null },
        ],
        intent: {
          issue: {
            number: 334,
            title: "Add intent and agent claims to the Dossier",
            url: "https://github.com/getoxide/oxide/issues/334",
          },
          prompts: ["Add the parser", "Handle the empty input"],
        },
        claim: { turnIndex: 0, text: "All 12 tests pass." },
      };
    }
    if (command === "get_project_verification_commands") return ["pnpm run verify"];
    if (command === "plugin:event|listen") return 1;
    return null;
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  clearMocks();
  localStorage.clear();
});

async function openDiff() {
  await act(async () => root.render(<App />));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Toggle tools panel"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Diff"]')!.click());
  await vi.waitFor(() => expect(host.querySelector(".dossier")).not.toBeNull());
}

it("shows every Verification state beside the diff", async () => {
  await openDiff();
  const row = (command: string) => host.querySelector(`[aria-label^="${command}: "]`);
  await vi.waitFor(() => expect(row("cargo test")).not.toBeNull());

  expect(row("cargo test")!.getAttribute("aria-label")).toBe("cargo test: Fresh");
  expect(row("cargo clippy")!.getAttribute("aria-label")).toBe("cargo clippy: Stale");
  expect(row("pytest")!.getAttribute("aria-label")).toBe("pytest: Failed");
  expect(row("pnpm run verify")!.getAttribute("aria-label")).toBe("pnpm run verify: Never run");
  expect(row("tsc")!.getAttribute("aria-label")).toBe("tsc: Unknown");
  expect(host.textContent).toContain("Test");
  expect(host.textContent).toContain("Lint");
  expect(host.textContent).toContain("Type check");
  expect(host.textContent).toContain("Turn 1");
  expect(host.textContent).toContain("exit 1");
});

it("shows what was asked and keeps the agent's claim apart from the computed checks", async () => {
  await openDiff();
  const intent = await vi.waitFor(() => {
    const section = host.querySelector<HTMLElement>('[aria-label="Intent"]');
    expect(section).not.toBeNull();
    return section!;
  });

  expect(intent.textContent).toContain("Issue #334");
  const link = intent.querySelector<HTMLAnchorElement>('a[href="https://github.com/getoxide/oxide/issues/334"]');
  expect(link?.textContent).toBe("#334 Add intent and agent claims to the Dossier");
  const prompts = intent.querySelector<HTMLDetailsElement>("details.dossier-prompts")!;
  expect(prompts.open).toBe(false);
  expect(prompts.querySelector("summary")?.textContent).toBe("Prompts (2)");
  expect(prompts.textContent).toContain("Add the parser");
  expect(prompts.textContent).toContain("Handle the empty input");
  expect(intent.textContent).not.toContain("All 12 tests pass.");

  const claim = host.querySelector<HTMLElement>('[aria-label="Agent claim"]')!;
  expect(claim.textContent).toContain("Agent claim");
  expect(claim.textContent).toContain("All 12 tests pass.");
  expect(claim.textContent).toContain("not checked by Oxide");
  const checks = host.querySelector<HTMLElement>(".dossier-checks")!;
  expect(checks.textContent).toContain("pytest");
  expect(checks.textContent).not.toContain("All 12 tests pass.");
});

it("adds a Project Verification command and asks for the Dossier again", async () => {
  await openDiff();
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project Verification commands"]')?.value).toBe(
      "pnpm run verify",
    ),
  );
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project Verification commands"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "pnpm run verify\nmake check");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = Array.from(host.querySelectorAll<HTMLButtonElement>(".dossier-commands button")).find((button) => button.textContent === "Save")!;
  await act(async () => save.click());

  const saved = calls.filter(({ command }) => command === "set_project_verification_commands").at(-1);
  expect(saved?.args).toEqual({ projectId: 1, commands: ["pnpm run verify", "make check"] });
  await vi.waitFor(() =>
    expect(calls.filter(({ command }) => command === "verification_dossier")).toHaveLength(2),
  );
});
