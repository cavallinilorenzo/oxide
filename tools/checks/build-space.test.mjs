import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { linkSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBuildSpace, buildBytes, compilesRust } from "./build-space.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oxide-build-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("an oversized target stops further builds without deleting artifacts", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "symbols.pdb"), Buffer.alloc(1024));
  assert.throws(() => assertBuildSpace(root, { OXIDE_BUILD_BUDGET_GIB: String(512 / 1024 ** 3) }), /Stopping local checks/);
  assert.equal(buildBytes(join(root, "target")), 1024);
});

test("the default budget warns without throwing away a reusable cache", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "target"));
  const artifact = join(root, "target", "large.rlib");
  writeFileSync(artifact, "cache");
  // Simulate a large artifact without allocating gigabytes on Windows or Unix.
  const originalStat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    const info = originalStat(path, ...args);
    if (path === artifact) info.size = 13 * 1024 ** 3;
    return info;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const warnings = [];
  assert.doesNotThrow(() => assertBuildSpace(root, {}, (message) => warnings.push(message)));
  assert.doesNotThrow(() => assertBuildSpace(root, {}, (message) => warnings.push(message)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cache.*retained/i);
  assert.equal(buildBytes(join(root, "target")), 13 * 1024 ** 3);
  assert.throws(() => assertBuildSpace(root, { OXIDE_BUILD_BUDGET_GIB: "12" }), /Stopping local checks/);
});

test("hard-linked artifacts count once toward an explicit disk budget", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "target"));
  const artifact = join(root, "target", "app");
  writeFileSync(artifact, Buffer.alloc(600));
  linkSync(artifact, join(root, "target", "app-linked"));
  assert.equal(buildBytes(join(root, "target")), 600);
  assert.doesNotThrow(() => assertBuildSpace(root, { OXIDE_BUILD_BUDGET_GIB: String(1024 / 1024 ** 3) }));
});

test("a clean checkout and files within budget allow builds", (t) => {
  const root = fixture(t);
  assert.doesNotThrow(() => assertBuildSpace(root, {}));
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "small.o"), "small");
  assert.doesNotThrow(() => assertBuildSpace(root, {}));
});

test("the configured Cargo target directory is checked too", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "custom-target"));
  writeFileSync(join(root, "custom-target", "data"), Buffer.alloc(1024));
  assert.throws(() => assertBuildSpace(root, { CARGO_TARGET_DIR: "custom-target", OXIDE_BUILD_BUDGET_GIB: String(512 / 1024 ** 3) }), /custom-target/);
});

test("invalid budgets fail before invoking a compiler", (t) => {
  const root = fixture(t);
  for (const value of ["0", "-1", "NaN", "Infinity", ""]) assert.throws(() => assertBuildSpace(root, { OXIDE_BUILD_BUDGET_GIB: value }), /positive number/);
});

test("directory links do not include unrelated artifacts or create traversal loops", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "data"), "abc");
  symlinkSync(root, join(root, "target", "loop"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(buildBytes(join(root, "target")), 3);
});

test("the budget applies to compilers, not formatting or frontend-only checks", () => {
  for (const command of [["cargo", "test", "--workspace"], ["cargo", "nextest", "run"], ["cargo", "clippy"], ["web/node_modules/.bin/tauri", "build"], ["web/node_modules/.bin/tauri.cmd", "build"]]) assert.equal(compilesRust(command), true);
  for (const command of [["cargo", "fmt"], ["cargo", "deny"], ["pnpm", "--dir", "web", "test"]]) assert.equal(compilesRust(command), false);
});
