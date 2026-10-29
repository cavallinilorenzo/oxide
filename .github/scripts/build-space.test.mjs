import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBuildSpace, buildBytes, compilesRust } from "../../tools/checks/build-space.mjs";

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
  for (const command of [["cargo", "test", "--workspace"], ["cargo", "clippy"], ["web/node_modules/.bin/tauri", "build"]]) assert.equal(compilesRust(command), true);
  for (const command of [["cargo", "fmt"], ["cargo", "deny"], ["pnpm", "--dir", "web", "test"]]) assert.equal(compilesRust(command), false);
});
