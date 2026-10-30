// Exercise the actual PR panel with synthetic IPC; never push or create a real PR.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { waitForLayout } from "./ui-review.mjs";

const engine = process.env.OXIDE_REVIEW_ENGINE ?? "chromium";
const engines = await import(process.env.OXIDE_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.OXIDE_PLAYWRIGHT_MODULE)).href : "playwright");
const output = resolve(process.argv[2] ?? "../docs/ui-review/pr-creation");
await mkdir(output, { recursive: true });
const browser = await engines[engine].launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(10_000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    let callbackId = 0;
    const callbacks = new Map();
    const project = { id: 1, name: "oxide", path: "C:/projects/oxide", hidden: false, open: true, missing: false };
    const provider = { model: null, effort: null, permissionMode: "auto-edit" };
    const settings = { defaultProvider: "claude", confirmQuit: true, claudeCustomizations: {},
      providers: { claude: provider, codex: provider, antigravity: provider } };
    const original = async (command) => {
      if (["list_projects", "rescan_projects"].includes(command)) return [project];
      if (command === "last_selection") return { projectId: 1, threadId: null };
      if (["list_threads", "list_slash_commands", "get_model_catalog", "get_favourite_models", "list_dir"].includes(command)) return [];
      if (command === "get_settings") return { settings, errors: [], scanRoots: [] };
      if (command === "get_provider_capabilities") return { supportedPermissionModes: ["ask", "auto-edit", "full-access"], interactiveApprovals: true, supportsReasoning: true, imageAttachments: true, midThreadModelSwitch: true, slashCommandPassthrough: false };
      if (command === "provider_capabilities") return { reasoningText: true, imageAttachments: true };
      if (command === "detect_provider") return { available: true, installed: true, authenticated: true, version: "2.0", warning: null };
      if (command === "plugin:event|listen") return ++callbackId;
      if (["plugin:event|unlisten", "remember_selection", "get_project_setup_command", "subscribe_usage_limits"].includes(command)) return null;
      if (command === "fetch_project") return false;
      throw new Error(`Missing PR review fixture: ${command}`);
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
    };
    const head = "fix/polish-pull-request-creation-and-error-feedback";
    window.__PR_REVIEW__ = { mode: "error", calls: 0, created: false };
    const pr = { number: 158, title: "Polish pull request creation", body: "", draft: true, head, base: "main", author: "demo", url: "https://github.com/example/repo/pull/158" };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const state = window.__PR_REVIEW__;
      if (command === "pull_request_state") return { availability: "ready", branch: head, defaultBranch: "main", guidance: null, pullRequest: state.created ? pr : null };
      if (command === "pull_request_draft") return { head, base: "main", title: "Polish pull request creation", body: "Refine the creation form and make GitHub errors actionable." };
      if (command === "pull_request_base_branches") return ["develop", "main", "release/next", head];
      if (command === "git_status") return { branch: head, upstream: null, ahead: 1, behind: 0, added: 12, removed: 4, changedFiles: 2, protected: false, unpublished: true, pickerDisabledReason: null };
      if (command === "pull_request_detail") return { pullRequest: pr, body: "Refine the creation form.", checks: [], comments: [], mergeMethods: ["squash"], deleteBranchOnMerge: true, diff: { files: [] } };
      if (command === "create_pull_request") {
        state.calls++;
        state.args = args;
        if (state.mode === "pending") await new Promise((resolve) => { state.release = resolve; });
        if (state.mode === "success") { state.created = true; return pr; }
        throw { message: `pull request create failed: GraphQL: No commits between ${args.base} and ${head} (createPullRequest)` };
      }
      return original(command, args);
    };
  });
  await page.goto(process.env.OXIDE_REVIEW_URL ?? "http://127.0.0.1:1420");
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  await page.getByRole("tab", { name: "Pull request", exact: true }).click();
  const form = page.getByRole("form", { name: "Create pull request" });
  await form.waitFor();
  const tools = page.getByRole("complementary", { name: "Tools panel" });
  const metrics = [];
  // The desktop Tools panel ships from 288px to 800px; include the attachment's width.
  for (const width of [288, 480, 800]) {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await tools.evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await waitForLayout(page);
    const create = form.getByRole("button", { name: "Push & create PR", exact: true });
    await create.click();
    await form.getByRole("alert").waitFor();
    assert.match(await form.getByRole("alert").innerText(), /No commits to compare/);
    assert.equal(await form.locator("details").getAttribute("open"), null);
    assert.equal(await form.getByRole("textbox", { name: "Title", exact: true }).inputValue(), "Polish pull request creation");
    const size = await form.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(size.scroll <= size.client + 1, `Form overflows at ${width}px`);
    metrics.push({ panel: width, ...size });
    await tools.screenshot({ path: `${output}/error-${width}-${engine}.png` });
    if (width === 480) {
      await form.getByText("Technical details", { exact: true }).click();
      await tools.screenshot({ path: `${output}/details-${engine}.png` });
      assert.match(await form.locator("pre").innerText(), /GraphQL: No commits between/);
      await form.getByText("Technical details", { exact: true }).click();
    }
  }
  await tools.evaluate((el) => { el.style.width = "480px"; });
  // A short desktop window must keep the action reachable by scrolling.
  await page.setViewportSize({ width: 900, height: 560 });
  await tools.evaluate((el) => { el.style.removeProperty("width"); });
  await form.getByRole("button", { name: "Push & create PR", exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await form.getByRole("button", { name: "Push & create PR", exact: true }).isVisible(), true);
  const shortPanel = await tools.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(shortPanel.scroll <= shortPanel.client + 1, "Short window panel overflows");
  await tools.screenshot({ path: `${output}/short-window-${engine}.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await tools.evaluate((el) => { el.style.width = "480px"; });
  await form.getByRole("button", { name: "Base branch: main", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await form.getByRole("textbox", { name: "Title", exact: true }).evaluate((el) => document.activeElement === el), true);
  await tools.screenshot({ path: `${output}/keyboard-focus-${engine}.png` });
  await form.getByRole("button", { name: "Base branch: main", exact: true }).click();
  const choices = page.getByRole("listbox", { name: "Base branch", exact: true });
  assert.deepEqual(await choices.getByRole("option").allTextContents(), ["develop", "main", "release/next"]);
  await tools.screenshot({ path: `${output}/base-branches-${engine}.png` });
  await choices.getByRole("option", { name: "develop", exact: true }).click();
  assert.equal(await form.getByRole("alert").count(), 0);
  await form.getByRole("checkbox", { name: "Draft", exact: true }).check();
  await page.evaluate(() => { window.__PR_REVIEW__.mode = "pending"; });
  await form.getByRole("textbox", { name: "Description", exact: false }).press("Control+Enter");
  await page.waitForFunction(() => !!window.__PR_REVIEW__.release);
  assert.equal(await form.getAttribute("aria-busy"), "true");
  assert.equal(await form.getByRole("textbox", { name: "Title", exact: true }).isDisabled(), true);
  assert.equal(await form.getByRole("button", { name: "Creating…" }).isDisabled(), true);
  await tools.screenshot({ path: `${output}/pending-${engine}.png` });
  await page.evaluate(() => { window.__PR_REVIEW__.release(); });
  await form.getByRole("alert").waitFor();
  await form.getByRole("button", { name: "Base branch: develop", exact: true }).press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await form.getByRole("button", { name: "Base branch: main", exact: true }).count(), 1);
  await page.evaluate(() => { window.__PR_REVIEW__.mode = "success"; });
  await form.getByRole("button", { name: "Push & create PR", exact: true }).click();
  await page.getByRole("heading", { name: "Polish pull request creation #158" }).waitFor();
  assert.equal(await form.count(), 0);
  assert.equal(await page.evaluate(() => window.__PR_REVIEW__.args.draft), true);
  assert.equal(await page.evaluate(() => window.__PR_REVIEW__.args.base), "main");
  await tools.screenshot({ path: `${output}/success-${engine}.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification-${engine}.json`, JSON.stringify({ engine, metrics, errors,
    checked: ["long branch", "narrow panel", "short window", "keyboard focus", "error disclosure", "draft preservation", "Ctrl+Enter", "pending", "GitHub branch selection by pointer and keyboard", "current branch excluded", "creation success"] }, null, 2));
} catch (cause) {
  await page.screenshot({ path: `${output}/failure-${engine}.png` });
  process.stderr.write(JSON.stringify({ errors, text: await page.locator("body").innerText() }, null, 2));
  throw cause;
} finally {
  await browser.close();
}
