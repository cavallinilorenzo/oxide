// Real App + deterministic native commands. No live Provider or repository.
import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openReview, waitForLayout } from "./ui-review.mjs";
const output = resolve(process.argv[2] ?? "../docs/ui-review/window");
await mkdir(output, { recursive: true });
const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium", "completed", true);
try {
  await page.locator(".agent-message").waitFor();
  assert.equal(await page.getByRole("group", { name: "Work mode" }).count(), 0, "Work modes are removed");
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  assert.deepEqual(await page.getByRole("tablist", { name: "Surfaces", exact: true }).getByRole("tab").allTextContents().then(t => t.map(x => x.trim())), ["Diff", "Files", "Terminal", "Pull request", "Issues"]);
  await page.getByRole("tab", { name: "Diff", exact: true }).click();
  await page.locator(".diff").waitFor();
  const draft = page.getByRole("textbox", { name: "Message to agent", exact: true });
  await draft.fill("Retain my draft while reviewing");
  for (const [width, height] of [[1440, 900], [900, 560]]) {
    await page.setViewportSize({ width, height }); await waitForLayout(page);
    assert.equal(await page.getByRole("main", { name: "Thread", exact: true }).isVisible(), true);
    assert.ok((await page.getByRole("main", { name: "Thread", exact: true }).boundingBox()).width >= 360);
    assert.equal(await page.locator(".sidebar-region").isVisible(), width === 1440);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}/thread-diff-${width}.png`, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  await page.getByRole("complementary", { name: "Tools panel", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.locator(".sidebar-region").isVisible(), true);
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForLayout(page);
  await page.getByRole("complementary", { name: "Tools panel", exact: true }).waitFor();
  assert.equal(await page.locator(".sidebar-region").isVisible(), true);
  await page.setViewportSize({ width: 900, height: 560 }); await waitForLayout(page);
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  await page.getByRole("complementary", { name: "Tools panel", exact: true }).waitFor();
  await page.getByRole("button", { name: "Maximize Surface", exact: true }).click();
  assert.equal(await page.getByRole("main", { name: "Thread", exact: true }).isVisible(), false);
  await page.screenshot({ path: `${output}/maximized-900.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Restore Thread", exact: true }).click();
  assert.equal(await draft.innerText(), "Retain my draft while reviewing");
  await page.getByRole("button", { name: "Close tools panel", exact: true }).click();
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  assert.equal(await page.getByRole("tab", { name: "Diff", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "package.json", exact: true }).click();
  await page.locator(".monaco-editor").waitFor();
  await page.getByRole("button", { name: "Close package.json", exact: true }).waitFor();
  const editor = await page.locator(".monaco-editor").elementHandle();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await page.locator(".terminal-workbench").waitFor();
  await page.waitForFunction(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal > 0);
  const spawns = await page.evaluate(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal);
  await page.getByRole("button", { name: "Maximize Surface", exact: true }).click();
  await page.getByRole("button", { name: "Restore Surface", exact: true }).click();
  await page.getByRole("button", { name: "Close tools panel", exact: true }).click();
  await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal), spawns, "hiding/maximizing never respawns the shell");
  await page.setViewportSize({ width: 1440, height: 900 }); await waitForLayout(page);
  await page.getByRole("button", { name: "Thread Board of oxide", exact: true }).click();
  await page.getByRole("complementary", { name: "Tools panel", exact: true }).waitFor({ state: "hidden" });
  await page.locator(".thread-row").first().getByRole("button").first().click();
  assert.equal(await page.getByRole("tab", { name: "Terminal", exact: true }).getAttribute("aria-selected"), "true");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("complementary", { name: "Tools panel", exact: true }).waitFor({ state: "hidden" });
  await page.getByRole("main", { name: "Settings", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  assert.equal(await editor.evaluate((element) => element === document.querySelector(".monaco-editor")), true, "the Files editor instance survives all presentation changes");
  for (const name of ["Pull request", "Issues"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    assert.equal(await page.getByRole("main", { name: "Thread", exact: true }).isVisible(), true);
  }
  assert.equal(await draft.innerText(), "Retain my draft while reviewing");
  await page.getByRole("tab", { name: "Diff", exact: true }).click();
  await page.evaluate(() => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "git_diff") await new Promise((resolve) => { window.__WINDOW_RELEASE_DIFF__ = resolve; });
      return invoke(command, args);
    };
  });
  await page.getByRole("tab", { name: "Branch", exact: true }).click();
  await page.locator(".skeleton-diff").waitFor();
  assert.equal(await page.locator(".header").isVisible(), true);
  assert.equal(await draft.isVisible(), true);
  await page.evaluate(() => window.__WINDOW_RELEASE_DIFF__());
  await page.locator(".skeleton-diff").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification.json`, JSON.stringify({ sizes: [[1440,900],[900,560]], modesRemoved: true, stableDock: true, draftRetained: true, errors }, null, 2) + "\n");
} finally { await browser.close(); }


// Old presentation preferences cannot implicitly create a Core shell.
for (const [mode, surface] of [["terminal", "Terminal"], ["code", "Files"]]) {
  const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium", "completed", true);
  try {
    await page.addInitScript((mode) => localStorage.setItem("oxide:work-mode", mode), mode);
    await page.reload();
    await page.getByRole("tab", { name: surface, exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: surface, exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal ?? 0), 0);
    if (surface === "Terminal") {
      await page.getByRole("button", { name: "Open terminal", exact: true }).click();
      await page.waitForFunction(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal > 0);
    } else await page.getByRole("main", { name: "Code editor", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("oxide:work-mode")), null);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
for (const scenario of ["empty", "no-project"]) {
  const { browser, page, errors } = await openReview(process.env.OXIDE_REVIEW_ENGINE ?? "chromium", scenario, true);
  try {
    await page.locator(scenario === "empty" ? ".project-overview" : ".empty-thread").waitFor();
    assert.equal(await page.locator(".header").isVisible(), true);
    assert.equal(await page.locator(".git-header").count(), 0);
    if (scenario === "no-project") await page.getByRole("main", { name: "Thread", exact: true }).getByRole("button", { name: /Open a Project/ }).waitFor();
    else {
      await page.getByRole("button", { name: "Toggle tools panel", exact: true }).click();
      await page.getByRole("tab", { name: "Terminal", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Open terminal", exact: true }).isDisabled(), true);
    }
    assert.equal(await page.evaluate(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_block_terminal ?? 0), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
