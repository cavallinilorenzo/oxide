// Exercises Project selection through the actual App, using synthetic IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { openReview, waitForLayout } from "./ui-review.mjs";

const engine = process.env.OXIDE_REVIEW_ENGINE ?? "chromium";
const output = resolve(process.argv[2] ?? "/tmp/oxide-palette-review");
await mkdir(output, { recursive: true });
const { browser, page, errors } = await openReview(engine, "palette");
async function openPalette() {
  await page.getByRole("button", { name: "Open a Project", exact: true }).click();
  await page.getByRole("dialog", { name: "Project palette" }).waitFor();
}
async function waitForCreated(projectId, count) {
  await page.waitForFunction(({ projectId, count }) => window.__OXIDE_REVIEW_LAST_CREATED_THREAD__?.projectId === projectId
    && window.__OXIDE_REVIEW_COMMAND_COUNTS__.create_thread === count, { projectId, count });
  assert.equal(await page.getByRole("dialog", { name: "Project palette" }).count(), 0);
}
try {
  await openPalette();
  await page.getByRole("option", { name: /uni/ }).hover();
  assert.equal(await page.getByRole("option", { name: /uni/ }).getAttribute("aria-selected"), "true");
  await page.screenshot({ path: `${output}/palette-selection.png` });
  await page.getByRole("option", { name: /uni/ }).click();
  await waitForCreated(2, 1);
  assert.equal(await page.locator(".header .title strong").textContent(), "uni");
  await page.locator(".empty-thread").waitFor();
  await waitForLayout(page);
  await page.screenshot({ path: `${output}/selected-project.png` });

  await openPalette();
  await page.getByRole("combobox", { name: "Search", exact: true }).fill("oxide");
  await page.keyboard.press("Enter");
  await waitForCreated(1, 2);
  assert.equal(await page.locator(".header .title strong").textContent(), "oxide");
  await openPalette();
  await page.getByRole("combobox", { name: "Search", exact: true }).fill("oxide");
  await page.getByRole("option", { name: /oxide/ }).click();
  await waitForCreated(1, 3);

  await openPalette();
  const search = page.getByRole("combobox", { name: "Search", exact: true });
  await search.press("ArrowUp");
  const active = page.locator('.palette-list [aria-selected="true"]');
  assert.equal(await active.textContent(), "Clone one of your GitHub repositories");
  assert.equal(await search.getAttribute("aria-activedescendant"), await active.getAttribute("id"));
  const fullyVisible = await active.evaluate((el) => {
    const row = el.getBoundingClientRect();
    const list = el.closest(".palette-list").getBoundingClientRect();
    return row.top >= list.top && row.bottom <= list.bottom;
  });
  assert.equal(fullyVisible, true);
  await page.getByRole("option", { name: "Add a local folder as a Project", exact: true }).click();
  await page.getByRole("textbox", { name: "Folder to add", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("option", { name: "Clone one of your GitHub repositories", exact: true }).click();
  await page.getByRole("option", { name: /demo\/uni/ }).click();
  await page.getByRole("textbox", { name: "Parent folder", exact: true }).waitFor();
  assert.ok((await page.locator(".palette-title").textContent()).includes("Clone demo/uni"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The merged main branch adds this menu; ensure conflict resolution retained it.
  const composer = page.getByRole("textbox", { name: "Message to agent", exact: true });
  await composer.fill("/rev");
  await page.getByRole("listbox", { name: "Slash commands" }).waitFor();
  await page.keyboard.press("Tab");
  assert.equal(await composer.inputValue(), "/review ");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification-${engine}.json`, JSON.stringify({ engine, createdThreads: 3, projectSelection: "pointer + keyboard",
    actions: "local folder + GitHub repository", slashMenu: "retained and keyboard-selectable", errors }, null, 2));
} finally { await browser.close(); }
