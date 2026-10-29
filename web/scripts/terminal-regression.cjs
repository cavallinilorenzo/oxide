// Opt-in browser regression with the actual Rust PTY. No Provider/model prompts.
const { chromium } = require(process.env.OXIDE_PLAYWRIGHT_PATH || "playwright");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const repository = path.resolve(__dirname, "../..");
(async () => {
  const child = spawn(
    path.join(
      repository,
      "target/debug/examples",
      process.platform === "win32"
        ? "terminal_harness.exe"
        : "terminal_harness",
    ),
    [],
    { windowsHide: true },
  );
  let ready,
    page,
    attached = false,
    sequence = 0;
  const requests = new Map(),
    queued = [],
    resizes = [],
    errors = [];
  const initialized = new Promise((resolve) => (ready = resolve));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.ready) ready(message);
    else if (message.bytes) {
      if (attached)
        void page
          .evaluate((bytes) => window.nativeOutput(bytes), message.bytes)
          .catch(() => {});
      else queued.push(message.bytes);
    } else {
      const pending = requests.get(message.request);
      requests.delete(message.request);
      if (message.result.Err) pending.reject(new Error(message.result.Err));
      else pending.resolve(message.result.Ok);
    }
  });
  child.stderr.on("data", (data) => process.stderr.write(data));
  let browser;
  try {
    const info = await initialized;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.exposeFunction(
      "nativeTerminal",
      (cmd, args) =>
        new Promise((resolve, reject) => {
          if (cmd === "resize_terminal")
            resizes.push({ rows: args.rows, cols: args.cols });
          const request = ++sequence;
          requests.set(request, { resolve, reject });
          child.stdin.write(JSON.stringify({ request, cmd, args }) + "\n");
        }),
    );
    await page.addInitScript((root) => (window.terminalRoot = root), info.root);
    await page.goto(
      (process.env.OXIDE_TEST_URL || "http://127.0.0.1:1420") +
        "/tests/terminal-harness.html" +
        (process.argv.includes("--appearance") ? "?appearance" : ""),
    );
    const input = page.getByLabel("Terminal command");
    await input.waitFor();
    while (queued.length)
      await page.evaluate(
        (bytes) => window.nativeOutput(bytes),
        queued.shift(),
      );
    attached = true;
    const command = "python tui_fixture.py";
    await input.fill(command);
    await page
      .getByRole("button", { name: "Run command", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.querySelector('.terminal-workbench[data-fullscreen="true"]'),
    );
    await page.waitForTimeout(1200);
    const snapshot = await page.evaluate(() => ({
      height: document
        .querySelector(".terminal-block-output")
        .getBoundingClientRect().height,
      path: document.querySelector(".workbench-terminal-header .mono")
        .textContent,
    }));
    assert.ok(
      snapshot.height > 650,
      `Interactive app was clipped to ${snapshot.height}px`,
    );
    assert.ok(!snapshot.path.startsWith("\\\\?\\"));
    assert.ok(resizes.length <= 3, "Output generated a PTY resize storm");
    const output =
      process.env.OXIDE_TEST_OUTPUT ||
      path.join(repository, "docs/ui-review/terminal-refinement");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "native-fullscreen.png") });
    await input.waitFor({ state: "visible" });
    await input.fill("echo WORKBENCH_READY");
    await page
      .getByRole("button", { name: "Run command", exact: true })
      .click();
    await input.waitFor({ state: "visible" });
    const layout = await page.locator(".terminal-command-block").last().evaluate((block) => {
      const command = block.querySelector("header code");
      const output = block.querySelector(".terminal-block-output");
      return { border: getComputedStyle(block).borderTopWidth, commandX: command.getBoundingClientRect().x, outputX: output.getBoundingClientRect().x };
    });
    assert.notEqual(layout.border, "0px", "Commands need a visible separator");
    assert.ok(Math.abs(layout.commandX - layout.outputX) < 2, "Command and output must share a text edge");
    await page.locator(".terminal-command-block").last().locator(".block-duration").waitFor();
    await page.screenshot({ path: path.join(output, "native-blocks.png") });
    await input.fill("echo");
    await input.press("ArrowRight");
    assert.equal(await input.inputValue(), "echo WORKBENCH_READY");
    await input.fill(
      process.platform === "win32" ? "Get-Content ./comp" : "cat ./comp",
    );
    await input.press("Tab");
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Terminal command"]')
        .value.includes("completion-example.txt"),
    );
    await input.fill("");
    await input.press("ArrowUp");
    await page.getByRole("dialog", { name: "Command history" }).waitFor();
    await page.screenshot({ path: path.join(output, "native-history.png") });
    if (process.argv.includes("--appearance")) {
      await input.press("Escape");
      await page
        .getByLabel("Code editor font", { exact: true })
        .selectOption("Consolas");
      await page.getByText("Edit theme JSON", { exact: false }).click();
      await page
        .getByLabel("Theme JSON", { exact: true })
        .fill(
          fs.readFileSync(
            path.join(repository, "docs/themes/oxide-night.json"),
            "utf8",
          ),
        );
      await page.getByRole("button", { name: /^Theme variant:/ }).click();
      await page
        .getByRole("option", { name: "Oxide Night", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Apply appearance", exact: true })
        .click();
      await page.getByText("Appearance saved", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, "appearance.png") });
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        { passed: true, snapshot, resizes, browserErrors: errors },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    child.stdin.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
