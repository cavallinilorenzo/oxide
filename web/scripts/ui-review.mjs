// Render the real frontend with deterministic IPC fixtures; never opens a real
// Project, starts a Provider, or writes to the user's Oxide settings.
// Supply an installed Playwright module through OXIDE_PLAYWRIGHT_MODULE.
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { chromium, webkit } = await import(process.env.OXIDE_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.OXIDE_PLAYWRIGHT_MODULE)).href : "playwright");
export async function waitForLayout(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // The file split observes a region resized by the outer workspace observer.
  await page.waitForFunction(() => {
    const files = document.querySelector(".files");
    return !files?.dataset.splitAxis || files.dataset.splitAxis === (files.getBoundingClientRect().width > 560 ? "x" : "y");
  });
}
export async function openReview(engine = "chromium", scenario = "completed") {
  const browser = await ({ chromium, webkit }[engine]).launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((scenario) => {
    let callbackId = 0;
    const callbacks = new Map();
    const commandCounts = {};
    window.__OXIDE_REVIEW_COMMAND_COUNTS__ = commandCounts;
    const project = { id: 1, name: "oxide", path: "/Users/demo/Developer/projects/oxide", hidden: false, open: true, missing: false };
    const base = { projectId: 1, provider: "claude", model: "claude-sonnet-4-6", effort: "medium", permissionMode: "auto-edit", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionLost: false, continuedFrom: null, continuedIn: null, branch: null, worktreePath: null, setupOutput: null, issueNumber: null };
    const threads = [
      { ...base, id: 1, title: "Review desktop interface consistency", status: "completed" },
      { ...base, id: 2, title: "Improve keyboard navigation and focus visibility across shared components", status: "needs-input" },
      { ...base, id: 3, title: "Check Git status refresh", status: "working" },
      { ...base, id: 4, title: "Investigate provider connection", status: "error" },
    ];
    const provider = { model: null, effort: null, permissionMode: "auto-edit" };
    const settings = { defaultProvider: "claude", confirmQuit: true, editor: "", claudeCustomizations: false, providers: { claude: provider, codex: provider, antigravity: provider } };
    const caps = { supportedPermissionModes: ["ask", "auto-edit", "full-access"], interactiveApprovals: true, supportsReasoning: true, imageAttachments: true, midThreadModelSwitch: true, slashCommandPassthrough: false };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args = {}) {
        commandCounts[command] = (commandCounts[command] ?? 0) + 1;
        if (command === "plugin:event|listen") return ++callbackId;
        if (["plugin:event|unlisten", "remember_selection", "resize_terminal", "close_terminal", "write_terminal"].includes(command)) return null;
        if (command === "list_projects" || command === "rescan_projects") return [project];
        if (command === "last_selection") return { projectId: 1, threadId: ({ completed: 1, approval: 2, working: 3, error: 4, empty: null })[scenario] };
        if (command === "list_threads") return scenario === "empty" ? [] : threads;
        if (command === "get_settings") return { settings, errors: [], scanRoots: [] };
        if (command === "set_thread_permission_mode") {
          threads.find((thread) => thread.id === args.threadId).permissionMode = args.permissionMode;
          return null;
        }
        if (command === "save_settings") { Object.assign(settings, args.settings); return null; }
        if (command === "get_provider_capabilities") return caps;
        if (command === "provider_capabilities") return { reasoningText: true, imageAttachments: true };
        if (command === "detect_provider") return { available: true, installed: true, authenticated: true, version: "2.0", warning: null };
        if (command === "get_model_catalog") return [{ id: "claude-sonnet-4-6", name: "Sonnet", supportedEfforts: ["low", "medium", "high"] }];
        if (command === "get_favourite_models") return [];
        if (command === "detected_editors") return [{ bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" }];
        if (command === "get_project_setup_command") return null;
        if (command === "git_status") return { branch: "fix/desktop-ui-consistency", upstream: "origin/main", ahead: 0, behind: 0, added: 42, removed: 12, changedFiles: 4, pickerDisabledReason: null, protected: false, unpublished: false };
        if (command === "fetch_project") return false;
        if (command === "list_branches") return [{ name: "main", current: false }, { name: "fix/desktop-ui-consistency", current: true }];
        if (command === "start_terminal") return { id: 1 };
        if (command === "list_dir") return [
          { name: "src", path: "src", isDir: true },
          { name: "package.json", path: "package.json", isDir: false },
          { name: "desktop-interface-consistency-review.md", path: "docs/desktop-interface-consistency-review.md", isDir: false },
        ];
        if (command === "subscribe_thread") {
          const thread = threads.find((thread) => thread.id === args.threadId);
          const running = ["working", "needs-input"].includes(thread.status);
          return {
            thread, capabilities: { reasoningText: true, imageAttachments: true }, turnOffset: 0, turnCount: 1, lastSeq: 0, supportedPermissionModes: caps.supportedPermissionModes,
            turns: [{ id: 1, turnIndex: 0, prompt: "Review the desktop workspace and shared controls.", model: "claude-sonnet-4-6", effort: "medium", status: running ? "running" : thread.status === "error" ? "error" : "completed", startedAt: new Date().toISOString(), completedAt: running ? null : new Date().toISOString(),
              error: thread.status === "error" ? { message: "Provider connection interrupted.", stderrTail: "Connection closed before the response completed." } : null,
              approvals: thread.status === "needs-input" ? [{ id: 1, approvalId: "review-command", kind: "command", summary: "git diff --stat", options: [], decision: null, createdAt: new Date().toISOString() }] : [], attachments: [], unknownEvents: [],
              items: [{ id: 1, itemIndex: 0, kind: "agent_message", status: "completed", content: "The workspace keeps Projects, Threads and Git actions close at hand. Check contrast, keyboard focus and long labels while preserving the compact layout." }] }],
          };
        }
        throw new Error(`UI review fixture missing command: ${command}`);
      },
    };
  }, scenario);
  await page.goto(process.env.OXIDE_REVIEW_URL ?? "http://127.0.0.1:1420");
  await page.locator(".thread-title").waitFor();
  if (scenario !== "empty") await page.locator(".agent-message").waitFor();
  await page.locator(".files-row").first().waitFor();
  await page.locator(".terminal-host .xterm").waitFor();
  await waitForLayout(page);
  return { browser, page, errors };
}

export async function verifyReview(page, output) {
  const metrics = [];
  for (const [width, height] of [[1920, 1080], [1280, 800], [1024, 768], [900, 560]]) {
    await page.setViewportSize({ width, height });
    await waitForLayout(page);
    const layout = await page.evaluate(() => {
      const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
      const obscured = [...document.querySelectorAll(".header button")].filter((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return rect.right > innerWidth || rect.left < 84 || !button.contains(hit);
      }).map((button) => button.textContent || button.getAttribute("aria-label"));
      return { width: innerWidth, centre: bounds(".centre-column").width, composer: bounds(".composer").width, obscured,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        footerOverflow: document.querySelector(".composer-footer").scrollWidth > bounds(".composer-footer").width + 1 };
    });
    assert.equal(layout.documentOverflow, false, `Document overflow at ${width}`);
    assert.equal(layout.footerOverflow, false, `Checkout overflow at ${width}`);
    assert.deepEqual(layout.obscured, [], `Header actions obscured at ${width}`);
    assert.ok(layout.centre >= 360, `Thread too narrow at ${width}: ${layout.centre}`);
    metrics.push(layout);
    if (width === 900 && output) await page.screenshot({ path: `${output}/after-workspace-900.png`, animations: "disabled" });
  }
  // Real keyboard focus, including controls inside clipped/scrollable panels.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-current"), "page");
  const checkbox = page.getByRole("checkbox", { name: "Confirm before quitting" });
  await page.keyboard.press("Tab");
  await checkbox.focus();
  assert.equal(await checkbox.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"), true);
  assert.equal(await page.locator(".tools").count(), 0);
  assert.equal(await page.locator("section.terminal").isVisible(), false);
  if (output) await page.screenshot({ path: `${output}/after-checkbox-focus.png`, animations: "disabled" });
  const trigger = page.getByRole("button", { name: /^Claude Code Permission mode:/ });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  const menu = await page.getByRole("listbox").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { portaled: el.parentElement === document.body, fits: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
  });
  assert.deepEqual(menu, { portaled: true, fits: true });
  if (output) await page.screenshot({ path: `${output}/after-dropdown-900.png`, animations: "disabled" });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.getByLabel("Claude Code Full access warning").isVisible(), true);
  await trigger.click();
  await page.keyboard.press("Escape");
  assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Settings saved." }).waitFor();
  await checkbox.click();
  assert.equal(await page.getByRole("status").textContent(), "");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".composer").waitFor();
  assert.equal(await page.locator(".tools").isVisible(), true);
  assert.equal(await page.locator("section.terminal").isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-current"), null);
  // The compact native select must retain a complete pointer and keyboard target.
  const permission = page.getByRole("combobox", { name: "Permission mode" });
  const permissionBounds = await permission.boundingBox();
  assert.ok(permissionBounds.width >= 24 && permissionBounds.height >= 24);
  await permission.focus();
  assert.equal(await permission.evaluate((el) => getComputedStyle(el.closest("label")).outlineStyle), "solid");
  await permission.selectOption("ask");
  await page.waitForFunction(() => document.querySelector("#permission-mode-select")?.value === "ask");
  assert.equal(await permission.inputValue(), "ask");
  await page.getByRole("textbox", { name: "Message to agent" }).focus();
  assert.equal(await page.locator(".composer").evaluate((el) => getComputedStyle(el).borderColor), "rgb(88, 166, 255)");
  const heights = await page.locator(".thread-header-bar, .tools > .tabs, .terminal-toolbar").evaluateAll((elements) => elements.map((el) => el.getBoundingClientRect().height));
  assert.deepEqual(heights, [40, 40, 40]);
  const row = page.locator(".thread-row").first();
  const title = row.locator(".thread-item-title");
  const beforeHover = await title.boundingBox();
  await row.hover();
  assert.equal((await title.boundingBox()).width, beforeHover.width, "Hover must not reflow the Thread title");
  const rowAction = row.getByRole("button", { name: /^Delete / });
  await rowAction.focus();
  await page.mouse.move(0, 0);
  assert.equal(await rowAction.evaluate((el) => getComputedStyle(el).pointerEvents), "auto");
  assert.equal(await rowAction.evaluate((el) => getComputedStyle(el).opacity), "1");
  // Stress long repository and branch labels without invoking a real backend.
  await page.locator(".header .title strong").evaluate((el) => { el.textContent = "a-very-long-project-name-that-must-not-cover-actions"; });
  await page.locator(".header .branch-name").evaluate((el) => { el.textContent = "fix/a-very-long-branch-name/with-many-segments-and-an-unbroken-suffix"; });
  const hiddenActions = await page.locator(".header button").evaluateAll((buttons) => buttons.filter((el) => {
    const r = el.getBoundingClientRect();
    return !el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }).length);
  assert.equal(hiddenActions, 0, "Long labels obscure header actions");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.getByRole("button", { name: "Toggle Terminal" }).evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
  return metrics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? "docs/ui-review/screenshots");
  const prefix = process.argv[3] ?? "after";
  await mkdir(output, { recursive: true });
  const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium");
  try {
    await page.screenshot({ animations: "disabled", path: `${output}/${prefix}-workspace.png` });
    if (process.env.OXIDE_REVIEW_SCENARIOS) {
      await page.getByRole("textbox", { name: "Message to agent" }).fill("Check spacing and keyboard focus across the workspace.");
      await page.screenshot({ animations: "disabled", path: `${output}/${prefix}-composer-focus.png` });
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-card").first().waitFor();
    await page.screenshot({ animations: "disabled", path: `${output}/${prefix}-settings.png` });
    await page.getByRole("button", { name: /^Claude Code Permission mode:/ }).click();
    await page.getByRole("listbox").waitFor();
    await page.screenshot({ animations: "disabled", path: `${output}/${prefix}-dropdown.png` });
    if (process.env.OXIDE_REVIEW_VERIFY) {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      const metrics = await verifyReview(page, output);
      await writeFile(`${output}/verification-${process.env.OXIDE_REVIEW_ENGINE ?? "chromium"}.json`, JSON.stringify({ metrics, errors }, null, 2));
    }
    if (errors.length) throw new Error(errors.join("\n"));
  } finally { await browser.close(); }
  if (process.env.OXIDE_REVIEW_SCENARIOS) {
    const states = [];
    for (const scenario of ["empty", "working", "approval", "error"]) {
      const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium", scenario);
      try {
        if (scenario === "working" || scenario === "approval") {
          assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isVisible(), true);
          assert.equal(await page.getByRole("button", { name: "Model", exact: true }).isDisabled(), true);
        }
        if (scenario === "empty") assert.equal(await page.locator(".empty-thread").isVisible(), true);
        if (scenario === "approval") assert.equal(await page.getByRole("button", { name: "Allow", exact: true }).isEnabled(), true);
        if (scenario === "error") assert.equal(await page.getByRole("alert").isVisible(), true);
        for (const [width, height] of [[1280, 800], [900, 560]]) {
          await page.setViewportSize({ width, height });
          await waitForLayout(page);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow in ${scenario}`);
          const controlsFit = await page.locator(".composer").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return [...el.querySelectorAll(".composer-bar button, .composer-bar label")].every((control) => {
              const c = control.getBoundingClientRect();
              return c.left >= r.left && c.right <= r.right;
            });
          });
          assert.equal(controlsFit, true, `Composer controls overflow in ${scenario} at ${width}`);
          if (width === 1280) await page.screenshot({ path: `${output}/${prefix}-${scenario}.png`, animations: "disabled" });
        }
        assert.deepEqual(errors, []);
        states.push({ scenario, errors });
      } finally { await browser.close(); }
    }
    await writeFile(`${output}/states-${process.env.OXIDE_REVIEW_ENGINE ?? "chromium"}.json`, JSON.stringify(states, null, 2));
  }
}
