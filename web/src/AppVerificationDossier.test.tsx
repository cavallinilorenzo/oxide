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
const dossier = {
  commands: [
    { command: "cargo test", kind: "test", state: "fresh", turnIndex: 0, outcome: "succeeded", exitCode: 0 },
    { command: "cargo clippy", kind: "lint", state: "stale", turnIndex: 0, outcome: "succeeded", exitCode: 0 },
    { command: "pytest", kind: "test", state: "failed", turnIndex: 0, outcome: "failed", exitCode: 1 },
    { command: "pnpm run verify", kind: "other", state: "neverRun", turnIndex: null, outcome: null, exitCode: null },
    { command: "tsc", kind: "typeCheck", state: "unknown", turnIndex: 0, outcome: "succeeded", exitCode: null },
  ],
  signals: [
    {
      kind: "uncheckedLanguage",
      explanation: "Python changed with no Verification command.",
      files: ["src/parser.py"],
      language: "Python",
      threshold: null,
    },
    {
      kind: "sourceWithoutTests",
      explanation: "Source changed with no test change.",
      files: ["src/parser.rs"],
      language: null,
      threshold: null,
    },
    {
      kind: "sensitivePath",
      explanation: "Touches CI configuration.",
      files: [".github/workflows/ci.yml"],
      language: null,
      threshold: null,
    },
    {
      kind: "largeDiff",
      explanation: "The diff changes 512 lines, over the 400-line threshold.",
      files: ["src/parser.rs"],
      language: null,
      threshold: 400,
    },
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
  baseBranch: "main",
  coverageKnown: true,
  uncoveredCommits: [{ sha: "0123456789abcdef", subject: "fix the parser by hand" }],
  pullRequestKnown: true,
  pullRequest: {
    number: 42,
    url: "https://github.com/fake/repo/pull/42",
    checks: [
      { name: "rust", state: "success", url: null, required: true },
      { name: "web", state: "failure", url: null, required: true },
    ],
  },
  supervision: {
    approvalsGranted: 2,
    approvalsDenied: 1,
    permissionModes: [
      { mode: "ask", turns: 2 },
      { mode: null, turns: 1 },
    ],
  },
  blindReviews: [{ reviewThreadId: 9, provider: "codex", findings: 4, kept: 3 }],
};
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
    if (command === "verification_dossier" || command === "branch_dossier") return dossier;
    if (command === "get_project_verification_commands") return ["pnpm run verify"];
    if (command === "get_project_sensitive_paths") return ["src/billing/**"];
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

it("shows branch coverage, pull request checks and supervision in Branch scope", async () => {
  await openDiff();
  const branch = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (tab) => tab.textContent === "Branch",
  )!;
  await act(async () => branch.click());

  await vi.waitFor(() =>
    expect(host.querySelector('[aria-label="Commits not covered"]')?.textContent).toContain(
      "fix the parser by hand",
    ),
  );
  const check = (name: string) => host.querySelector(`[aria-label^="${name}: "]`);
  expect(check("rust")!.getAttribute("aria-label")).toBe("rust: Passed");
  expect(check("web")!.getAttribute("aria-label")).toBe("web: Failed");
  expect(host.querySelector('[aria-label="Pull request checks"]')?.textContent).toContain("Required");
  const supervision = host.querySelector('[aria-label="Supervision"]')!.textContent!;
  expect(supervision).toContain("2 granted, 1 denied");
  expect(supervision).toContain("Ask 2");
  expect(supervision).toContain("Unknown 1");
});

it("names the Blind reviewer and how many findings were kept", async () => {
  await openDiff();
  const section = await vi.waitFor(() => {
    const section = host.querySelector<HTMLElement>('[aria-label="Blind reviews"]');
    expect(section).not.toBeNull();
    return section!;
  });
  expect(section.textContent).toContain("codex");
  expect(section.textContent).toContain("3 of 4 findings kept");
});

it("shows each risk signal and links its files into the Diff", async () => {
  await openDiff();
  await vi.waitFor(() => expect(host.querySelectorAll('[aria-label^="Risk signal: "]')).toHaveLength(4));

  expect(host.textContent).toContain("Python changed with no Verification command.");
  expect(host.textContent).toContain("Source changed with no test change.");
  expect(host.textContent).toContain("Touches CI configuration.");
  expect(host.textContent).toContain("The diff changes 512 lines, over the 400-line threshold.");
  expect(host.textContent?.toLowerCase()).not.toContain("score");

  const link = host.querySelector<HTMLButtonElement>('[aria-label="Open src/parser.rs in the Diff"]')!;
  await act(async () => link.click());
  const row = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
    option.textContent?.includes("parser.rs"),
  );
  expect(row?.getAttribute("aria-selected")).toBe("true");
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
  const checks = host.querySelector<HTMLElement>('[aria-label="Verification commands"]')!;
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

it("adds a Project sensitive path and asks for the Dossier again", async () => {
  await openDiff();
  await vi.waitFor(() =>
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project sensitive paths"]')?.value).toBe(
      "src/billing/**",
    ),
  );
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project sensitive paths"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "src/billing/**\ninfra/**");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = Array.from(textarea.closest("details")!.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Save",
  )!;
  await act(async () => save.click());

  const saved = calls.filter(({ command }) => command === "set_project_sensitive_paths").at(-1);
  expect(saved?.args).toEqual({ projectId: 1, paths: ["src/billing/**", "infra/**"] });
  await vi.waitFor(() =>
    expect(calls.filter(({ command }) => command === "verification_dossier")).toHaveLength(2),
  );
});
