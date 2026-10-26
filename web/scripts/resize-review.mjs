// Browser regression checks for the real workspace with synthetic Tauri IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";
import { openReview, waitForLayout } from "./ui-review.mjs";

const engine = process.env.OXIDE_REVIEW_ENGINE ?? "chromium";
const output = resolve(process.argv[2] ?? "/tmp/oxide-resize-review");
await mkdir(output, { recursive: true });
const { browser, page, errors } = await openReview(engine);
const handle = (label) => page.getByRole("separator", { name: label, exact: true });
const value = (label) => handle(label).getAttribute("aria-valuenow").then(Number);
const stored = (key) => page.evaluate((key) => JSON.parse(localStorage.getItem(`oxide.layout.${key}`)), key);
async function drag(label, delta, release = true) {
  const locator = handle(label);
  const r = await locator.boundingBox();
  const xAxis = await locator.getAttribute("aria-orientation") === "vertical";
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + (xAxis ? delta : 0), r.y + r.height / 2 + (xAxis ? 0 : delta), { steps: 12 });
  if (release) await page.mouse.up();
  await waitForLayout(page);
}
async function fits() {
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    centre: document.querySelector(".centre-column").getBoundingClientRect().width,
    thread: document.querySelector(".centre").getBoundingClientRect().height,
    composer: document.querySelector(".composer").getBoundingClientRect(),
  }));
  assert.equal(layout.overflow, false, JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("body *")]
    .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
    .map((el) => ({ class: el.className, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width })).slice(0, 15))));
  assert.ok(layout.centre >= 360);
  assert.ok(layout.thread >= 280);
  assert.ok(layout.composer.bottom <= await page.evaluate(() => innerHeight));
  return { centre: layout.centre, thread: layout.thread };
}

const evidence = {};
try {
  assert.equal(await page.getByRole("separator").count(), 4);
  const initialTerminal = await page.evaluate(() => ({
    starts: window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_terminal,
    resizes: window.__OXIDE_REVIEW_COMMAND_COUNTS__.resize_terminal,
  }));
  await drag("Resize sidebar", 56);
  assert.equal(await value("Resize sidebar"), 296);
  await drag("Resize Tools", -190);
  assert.equal(await value("Resize Tools"), 600);
  await drag("Resize Terminal", -100);
  assert.equal(await value("Resize Terminal"), 300);
  assert.equal(await handle("Resize file tree").getAttribute("aria-orientation"), "vertical");
  const treeWidth = await value("Resize file tree");
  await drag("Resize file tree", 40);
  assert.equal(await value("Resize file tree"), treeWidth + 40);
  evidence.wide = await fits();
  const terminalCalls = await page.evaluate(() => ({
    starts: window.__OXIDE_REVIEW_COMMAND_COUNTS__.start_terminal,
    resizes: window.__OXIDE_REVIEW_COMMAND_COUNTS__.resize_terminal,
  }));
  assert.equal(terminalCalls.starts, initialTerminal.starts, "Dragging must not restart the Terminal");
  assert.ok(terminalCalls.resizes > initialTerminal.resizes, "Terminal geometry must be sent to the backend");
  evidence.terminal = { initial: initialTerminal, after: terminalCalls };
  const saved = { sidebar: await stored("sidebar"), tools: await stored("tools"), terminal: await stored("terminal"), treeWidth: await stored("files-width") };
  assert.deepEqual(saved, { sidebar: 296, tools: 600, terminal: 300, treeWidth: treeWidth + 40 });
  await page.screenshot({ path: `${output}/resized-workspace.png` });

  await page.reload();
  await page.locator(".files-row").first().waitFor();
  await waitForLayout(page);
  assert.equal(await value("Resize sidebar"), saved.sidebar);
  assert.equal(await value("Resize Tools"), saved.tools);
  assert.equal(await value("Resize Terminal"), saved.terminal);
  assert.equal(await value("Resize file tree"), saved.treeWidth);
  await page.getByRole("button", { name: "Toggle tools panel" }).click();
  await page.getByRole("button", { name: "Toggle tools panel" }).click();
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.getByRole("separator").count(), 1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".files-row").first().waitFor();
  await waitForLayout(page);
  assert.equal(await value("Resize Tools"), saved.tools);
  assert.equal(await value("Resize Terminal"), saved.terminal);

  await drag("Resize Tools", -16, false);
  await page.keyboard.press("Meta+,");
  await page.mouse.up();
  await waitForLayout(page);
  assert.equal(await page.locator("html").getAttribute("class"), "");
  assert.equal(await page.getByRole("separator").count(), 1);
  assert.equal(await stored("tools"), saved.tools, "Hiding an active splitter cancels its uncommitted preference");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator(".files-row").first().waitFor();
  await waitForLayout(page);
  assert.equal(await value("Resize Tools"), saved.tools);

  await page.setViewportSize({ width: 900, height: 560 });
  await waitForLayout(page);
  evidence.narrow = await fits();
  assert.equal(await handle("Resize file tree").getAttribute("aria-orientation"), "horizontal");
  assert.equal(await stored("sidebar"), saved.sidebar);
  assert.equal(await stored("tools"), saved.tools);
  assert.equal(await stored("terminal"), saved.terminal);
  const treeHeight = await value("Resize file tree");
  await drag("Resize file tree", 40);
  assert.equal(await value("Resize file tree"), treeHeight + 40);
  await handle("Resize Tools").focus();
  await page.screenshot({ path: `${output}/resized-minimum-window.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await waitForLayout(page);
  assert.equal(await value("Resize sidebar"), saved.sidebar);
  assert.equal(await value("Resize Tools"), saved.tools);
  assert.equal(await value("Resize Terminal"), saved.terminal);
  assert.equal(await value("Resize file tree"), saved.treeWidth);

  await handle("Resize sidebar").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await value("Resize sidebar"), 304);
  await page.keyboard.press("Shift+ArrowRight");
  assert.equal(await value("Resize sidebar"), 320);
  await page.keyboard.press("Home");
  assert.equal(await value("Resize sidebar"), 208);
  await page.keyboard.press("End");
  assert.equal(await value("Resize sidebar"), 320);
  await handle("Resize sidebar").dblclick();
  assert.equal(await stored("sidebar"), null);
  assert.equal(await value("Resize sidebar"), 240);
  await drag("Resize sidebar", 40, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await waitForLayout(page);
  assert.equal(await value("Resize sidebar"), 240);
  assert.equal(await stored("sidebar"), null, "Escape preserves automatic sizing");
  assert.equal(await page.locator("html").getAttribute("class"), "");
  await drag("Resize sidebar", 24, false);
  await handle("Resize sidebar").dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  assert.equal(await stored("sidebar"), 264);
  assert.equal(await page.locator("html").getAttribute("class"), "");

  await drag("Resize sidebar", 16, false);
  await handle("Resize sidebar").evaluate((el) => el.releasePointerCapture(1));
  await page.mouse.up();
  await waitForLayout(page);
  assert.equal(await stored("sidebar"), 280);
  assert.equal(await page.locator("html").getAttribute("class"), "");
  await drag("Resize sidebar", 16, false);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await waitForLayout(page);
  assert.equal(await stored("sidebar"), 296);
  assert.equal(await page.locator("html").getAttribute("class"), "");

  await handle("Resize Tools").focus();
  await page.keyboard.press("Enter");
  await handle("Resize Terminal").dblclick();
  assert.equal(await stored("tools"), null);
  assert.equal(await stored("terminal"), null);
  await page.reload();
  await page.locator(".files-row").first().waitFor();
  await waitForLayout(page);
  assert.equal(await value("Resize sidebar"), 296);

  // Chromium's input protocol delivers touch gestures through the browser's
  // pointer/capture path. WebKit below covers real mouse + keyboard input.
  if (engine === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const r = await handle("Resize sidebar").boundingBox();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    assert.equal(await handle("Resize sidebar").evaluate((el) => getComputedStyle(el).touchAction), "none");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 32, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await waitForLayout(page);
    assert.equal(await value("Resize sidebar"), 328);
    assert.equal(await stored("sidebar"), 328);
    assert.equal(await page.locator("html").getAttribute("class"), "");
    evidence.touch = "Chromium CDP touch drag passed";
    await cdp.detach();
  }

  // Exercise storage failures/corrupt data without changing application code.
  await page.evaluate(() => localStorage.setItem("oxide.layout.sidebar", "invalid-json"));
  await page.reload();
  await page.locator(".files-row").first().waitFor();
  await waitForLayout(page);
  assert.equal(await value("Resize sidebar"), 240);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); }; });
  await handle("Resize sidebar").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await value("Resize sidebar"), 248);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification-${engine}.json`, JSON.stringify({ engine, evidence, saved, errors }, null, 2));
} finally { await browser.close(); }
