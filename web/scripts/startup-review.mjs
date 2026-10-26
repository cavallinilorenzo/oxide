// Render the real bootstrap and hold only Project loading; never open a real Project.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const { chromium } = await import(process.env.OXIDE_PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.OXIDE_PLAYWRIGHT_MODULE)).href : "playwright");
const output = resolve(process.argv[2] ?? "../docs/ui-review/startup");
const base = process.env.OXIDE_REVIEW_URL ?? "http://127.0.0.1:1420";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const errors = [];
async function open(before = false) {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const callbacks = new Map();
    let callbackId = 0;
    const pending = [];
    window.__RELEASE_STARTUP__ = () => pending.splice(0).forEach((resolve) => resolve([]));
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(callback) { const id = ++callbackId; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command) {
        if (command === "list_projects") return new Promise((resolve) => pending.push(resolve));
        if (command === "last_selection") return null;
        if (["rescan_projects", "detected_editors"].includes(command)) return [];
        if (command === "plugin:event|listen") return ++callbackId;
        if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {}, confirmQuit: true, editor: "" }, errors: [], scanRoots: [] };
        if (["plugin:event|unlisten", "remember_selection"].includes(command)) return null;
        throw new Error(`Missing startup fixture: ${command}`);
      },
    };
  });
  if (before) {
    const html = execFileSync("git", ["show", "db4381a:web/index.html"], { encoding: "utf8" });
    await page.route(base + "/", (route) => route.fulfill({ body: html, contentType: "text/html" }));
    await page.route("**/src/main.tsx*", (route) => route.abort());
  }
  await page.goto(base);
  await page.locator(before ? "#boot-splash" : "#root .startup-screen").waitFor();
  return page;
}
try {
  const before = await open(true);
  await before.screenshot({ path: `${output}/before.png` });
  await before.close();
  const page = await open();
  const metrics = [];
  for (const time of [0, 200, 600, 1000, 2000, 3255, 5000, 6500, 6510]) {
    const pose = await page.evaluate((time) => {
      const circle = document.querySelector("#boot-splash circle");
      const animation = circle.getAnimations()[0];
      animation.pause();
      animation.currentTime = time;
      const style = getComputedStyle(circle);
      return { time, duration: animation.effect.getTiming().duration, dash: style.strokeDasharray,
        offset: parseFloat(style.strokeDashoffset), color: style.stroke, cap: style.strokeLinecap };
    }, time);
    assert.equal(pose.duration, 6510);
    assert.equal(pose.color, "rgb(66, 133, 244)");
    assert.equal(pose.cap, "butt");
    if (time === 600) assert.ok(parseFloat(pose.dash) < 25, "The reference contracts to a short arc");
    if (time === 1000) assert.ok(parseFloat(pose.dash) > 250, "The reference expands to a long arc");
    if ([0, 600, 1000, 2000].includes(time)) await page.locator("#boot-splash .startup-emblem").screenshot({ path: `${output}/pose-${time}.png` });
    metrics.push(pose);
  }
  assert.ok(Math.abs(metrics[0].offset - metrics.at(-1).offset) < 0.01, "The loop returns to the same pose");
  assert.equal(metrics[0].dash, metrics.at(-1).dash);
  assert.ok(Math.abs(metrics.at(-2).offset - metrics[0].offset + 2160) < 0.1, "Six clockwise turns per loop");
  await page.screenshot({ path: `${output}/after.png` });
  for (const [width, height] of [[900, 560], [1280, 800], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    const size = await page.locator("#boot-splash").evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    assert.equal(size.client, size.scroll);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#boot-splash circle").evaluate((el) => getComputedStyle(el).animationName), "none");
  await page.setViewportSize({ width: 900, height: 560 });
  await page.screenshot({ path: `${output}/reduced-motion.png` });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await page.locator("#boot-splash circle").evaluate((el) => getComputedStyle(el).animationPlayState), "paused");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  assert.equal(await page.locator("#boot-splash circle").evaluate((el) => getComputedStyle(el).animationPlayState), "running");
  await page.evaluate(() => window.__RELEASE_STARTUP__());
  await page.waitForFunction(() => document.documentElement.dataset.appReady === "true", undefined, { timeout: 2000 });
  assert.equal(await page.locator("#boot-splash").isVisible(), false);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/verification.json`, JSON.stringify({ reference: "https://miro.medium.com/1*X8HyF0-2dqv6DKYb-hzfpw.gif", metrics,
    checked: ["initial HTML before React", "shared bootstrap/React styling", "six-turn loop seam", "short and long arcs", "900/1280/1920px", "reduced motion", "hidden window pause/resume", "no artificial minimum startup time"], errors }, null, 2));
} finally {
  await browser.close();
}
