import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { openReview } from "./ui-review.mjs";

const output = "docs/ui-review/dictation";
await mkdir(output, { recursive: true });
const { browser, page, errors } = await openReview("chromium", "empty", true);
try {
  await page.getByRole("button", { name: "New Thread", exact: true }).first().click();
  const input = page.getByRole("textbox", { name: "Message to agent" });
  await input.focus();
  await page.keyboard.press("Control+Shift+R");
  await page.getByRole("status").filter({ hasText: "Listening" }).waitFor();
  await page.screenshot({ path: `${output}/recording.png` });
  await page.keyboard.press("Control+Shift+R");
  await page.waitForFunction(() => document.querySelector('[aria-label="Message to agent"]').textContent.includes("Test di dettatura locale"));
  assert.equal(await page.evaluate(() => window.__OXIDE_REVIEW_COMMAND_COUNTS__.send_prompt ?? 0), 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.locator('[aria-labelledby="settings-dictation"]');
  await section.scrollIntoViewIfNeeded();
  await section.getByText(/6.3 GB RAM/).waitFor();
  await page.screenshot({ path: `${output}/settings.png` });
  await page.setViewportSize({ width: 1064, height: 700 });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/settings-1064.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("Dictation shortcut, insertion without submit, Settings and minimum window width verified.");
} finally { await browser.close(); }
