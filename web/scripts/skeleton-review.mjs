// Real React surfaces with held IPC responses; no live repositories or Providers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { openReview, waitForLayout } from "./ui-review.mjs";

const output = resolve(process.argv[2] ?? "../docs/ui-review/skeletons");
await mkdir(output, { recursive: true });
const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium");
const checks = [];
try {
  await page.addInitScript(() => {
    const existing = window.__TAURI_INTERNALS__;
    let internals;
    window.__SKELETON_HOLD__ = [];
    window.__SKELETON_RELEASE__ = {};
    const issue = { number: 7, title: "Improve keyboard navigation", state: "OPEN", stateReason: "", author: "demo", url: "", commentsCount: 0, createdAt: "2026-10-27T12:00:00Z", labels: [], assignees: [] };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true, get: () => internals,
      set(value) {
        const original = value.invoke;
        value.invoke = async (command, args) => {
          if (window.__SKELETON_HOLD__.includes(command)) await new Promise((resolve) => { window.__SKELETON_RELEASE__[command] = resolve; });
          if (command === "issues_state") return { availability: "ready", guidance: null };
          if (command === "list_issues") return [issue, { ...issue, number: 8, title: "Keep the workspace responsive" }];
          if (command === "issue_detail") return { ...issue, body: "Keyboard navigation should remain available throughout the workspace.", comments: [], viewer: "demo" };
          if (command === "issue_templates" || command === "subscribe_board" || command === "list_pull_requests") return [];
          if (command === "git_diff" || command === "git_turn_diff") return { base: "main", files: [] };
          if (command === "list_dir" && args.path) return [];
          if (command === "read_file") return { path: "package.json", content: '{"name": "oxide"}', size: 17, binary: false, truncated: false };
          return original(command, args);
        };
        internals = value;
      },
    });
    if (existing) window.__TAURI_INTERNALS__ = existing;
  });
  await page.reload();
  await page.locator(".agent-message").waitFor();
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  const hold = (commands) => page.evaluate((commands) => { window.__SKELETON_HOLD__ = commands; }, commands);
  const release = (command) => page.evaluate((command) => { window.__SKELETON_HOLD__ = window.__SKELETON_HOLD__.filter((c) => c !== command); window.__SKELETON_RELEASE__[command]?.(); }, command);
  const capture = async (name, kind) => {
    await page.waitForFunction(() => window.__SKELETON_HOLD__.every((command) => window.__SKELETON_RELEASE__[command]));
    const skeleton = page.locator(`.skeleton-${kind}`).first();
    await skeleton.waitFor();
    await waitForLayout(page);
    assert.equal(await skeleton.getAttribute("aria-busy"), "true");
    assert.equal(await skeleton.locator("button, input, [tabindex]").count(), 0);
    const bounds = await skeleton.boundingBox();
    assert.ok(bounds.width > 50 && bounds.x + bounds.width <= 1281, `${name} fits its region`);
    await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
    checks.push(name);
  };
  await hold(["list_issues"]);
  await page.getByRole("tab", { name: "Issues", exact: true }).click();
  await capture("issues-loading", "list");
  const shapes = page.locator(".skeleton-list .skeleton-shapes").first();
  const poses = await shapes.evaluate((el) => {
    const animation = el.getAnimations()[0];
    const values = [0, 900].map((time) => { animation.pause(); animation.currentTime = time; return getComputedStyle(el).opacity; });
    animation.play(); return values;
  });
  assert.notEqual(poses[0], poses[1]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await shapes.evaluate((el) => getComputedStyle(el).animationName), "none");
  await page.screenshot({ path: `${output}/reduced-motion.png` });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await shapes.evaluate((el) => getComputedStyle(el).animationPlayState), "paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await shapes.evaluate((el) => getComputedStyle(el).animationPlayState), "running");
  await release("list_issues");
  await page.locator(".pr-panel").getByRole("button", { name: /Improve keyboard navigation/ }).waitFor();
  assert.equal(await page.locator(".skeleton-list").count(), 0);
  await page.screenshot({ path: `${output}/issues-ready.png` });
  await hold(["issue_detail"]);
  await page.locator(".pr-panel").getByRole("button", { name: /Improve keyboard navigation/ }).click();
  await capture("issue-detail-loading", "detail");
  await release("issue_detail");
  await page.getByRole("heading", { name: /Improve keyboard navigation/ }).waitFor();
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await hold(["issue_templates"]);
  await page.getByRole("button", { name: "New issue" }).click();
  await capture("issue-form-loading", "form");
  await release("issue_templates");
  await page.getByRole("tab", { name: "Diff", exact: true }).click();
  await hold(["git_diff"]);
  await page.getByRole("tab", { name: "Branch", exact: true }).click();
  await capture("diff-loading", "diff");
  await page.setViewportSize({ width: 900, height: 560 });
  await capture("diff-loading-compact", "diff");
  await page.setViewportSize({ width: 1280, height: 800 });
  await release("git_diff");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await hold(["list_dir"]);
  await page.getByRole("button", { name: "src", exact: true }).click();
  await capture("directory-loading", "tree");
  await release("list_dir");
  await hold(["read_file"]);
  await page.getByRole("button", { name: "package.json", exact: true }).first().click();
  await capture("file-loading", "code");
  await release("read_file");
  await hold(["subscribe_board"]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await capture("board-loading", "board");
  await release("subscribe_board");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await hold(["list_branches"]);
  await page.locator(".header .branch-name").click();
  await capture("branches-loading", "picker");
  await release("list_branches");
  await page.keyboard.press("Escape");
  await hold(["subscribe_thread"]);
  await page.locator(".thread-row").filter({ hasText: "Improve keyboard navigation and focus" }).getByRole("button").first().click();
  await capture("transcript-loading", "conversation");
  await release("subscribe_thread");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification-${process.env.OXIDE_REVIEW_ENGINE ?? "chromium"}.json`, JSON.stringify({ checks, poses, reducedMotion: true, hiddenWindowPause: true, loadingDismissed: true, errors }, null, 2) + "\n");
} finally { await browser.close(); }
