import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withBuildSession } from "../../tools/checks/build-session.mjs";

const silent = () => {};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oxide-build-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "target"));
  writeFileSync(join(root, "target", "running-app.exe"), "keep existing output");
  return root;
}

test("checks share their scratch target, which is removed once all checks finish", (t) => {
  const root = fixture(t);
  let target;
  const result = withBuildSession(root, { CUSTOM_VALUE: "kept" }, (session) => {
    target = session.target;
    assert.equal(session.env.CARGO_TARGET_DIR, target);
    assert.equal(session.env.CUSTOM_VALUE, "kept");
    writeFileSync(join(target, "test.pdb"), "temporary debug symbols");
    assert.ok(existsSync(join(target, "test.pdb")));
    return 42;
  }, silent);
  assert.equal(result, 42);
  assert.equal(existsSync(target), false);
  assert.equal(readFileSync(join(root, "target", "running-app.exe"), "utf8"), "keep existing output");
});

test("a failed check and a disk-budget exception both clean the scratch directory", (t) => {
  const root = fixture(t);
  let target;
  assert.equal(withBuildSession(root, {}, (session) => { target = session.target; return 1; }, silent), 1);
  assert.equal(existsSync(target), false);
  assert.throws(() => withBuildSession(root, {}, (session) => {
    target = session.target;
    writeFileSync(join(target, "failed-build.o"), "temporary");
    throw new Error("Build artifacts exceed budget");
  }, silent), /exceed budget/);
  assert.equal(existsSync(target), false);
});

test("an explicit Cargo target is a container, not something cleanup may remove", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "custom"));
  writeFileSync(join(root, "custom", "keep.txt"), "keep");
  withBuildSession(root, { CARGO_TARGET_DIR: "custom" }, (session) => {
    assert.equal(resolve(session.target, ".."), join(root, "custom"));
  }, silent);
  assert.deepEqual(readdirSync(join(root, "custom")), ["keep.txt"]);
});

test("successful Tauri builds keep final apps and bundles, but remove compiler caches", (t) => {
  const root = fixture(t);
  let target;
  withBuildSession(root, {}, (session) => {
    target = session.target;
    const release = join(target, "aarch64-apple-darwin", "release");
    mkdirSync(join(release, "bundle"), { recursive: true });
    mkdirSync(join(release, "deps"));
    writeFileSync(join(release, "bundle", "Oxide.dmg"), "installer");
    writeFileSync(join(release, "oxide-app"), "final binary");
    writeFileSync(join(release, "deps", "old.rlib"), "cache");
    session.preserve(["web/node_modules/.bin/tauri", "build", "--target", "aarch64-apple-darwin"]);
  }, silent);
  assert.equal(existsSync(target), false);
  const outputRoot = join(root, "target", "check-artifacts");
  const release = join(outputRoot, readdirSync(outputRoot)[0], "aarch64-apple-darwin", "release");
  assert.equal(readFileSync(join(release, "bundle", "Oxide.dmg"), "utf8"), "installer");
  assert.equal(readFileSync(join(release, "oxide-app"), "utf8"), "final binary");
  assert.equal(existsSync(join(release, "deps")), false);
});

test("a replaced scratch directory cannot redirect cleanup into another folder", (t) => {
  const root = fixture(t);
  const other = join(root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "keep.txt"), "keep");
  assert.throws(() => withBuildSession(root, {}, (session) => {
    rmSync(session.target, { recursive: true });
    symlinkSync(other, session.target, process.platform === "win32" ? "junction" : "dir");
  }, silent), /Refusing to clean/);
  assert.equal(readFileSync(join(other, "keep.txt"), "utf8"), "keep");
});

test("if final outputs cannot be preserved, the only copy is retained for recovery", (t) => {
  const root = fixture(t);
  let target;
  assert.throws(() => withBuildSession(root, {}, (session) => {
    target = session.target;
    writeFileSync(join(target, "diagnostic.txt"), "recover");
    session.preserve(["tauri", "build"]);
  }, silent), /Scratch files kept/);
  assert.equal(readFileSync(join(target, "diagnostic.txt"), "utf8"), "recover");
});

test("overlapping runs cannot remove each other's compiler files", (t) => {
  const root = fixture(t);
  withBuildSession(root, {}, (outer) => {
    writeFileSync(join(outer.target, "still-building.o"), "active");
    let innerTarget;
    withBuildSession(root, {}, (inner) => {
      innerTarget = inner.target;
      assert.notEqual(inner.target, outer.target);
    }, silent);
    assert.equal(existsSync(innerTarget), false);
    assert.equal(readFileSync(join(outer.target, "still-building.o"), "utf8"), "active");
  }, silent);
});

test("debug app builds keep the executable without retaining PDBs or dependencies", (t) => {
  const root = fixture(t);
  withBuildSession(root, {}, (session) => {
    const debug = join(session.target, "debug");
    mkdirSync(debug);
    writeFileSync(join(debug, "oxide-app.exe"), "executable");
    writeFileSync(join(debug, "oxide_app.pdb"), "symbols");
    session.preserve(["tauri", "build", "--debug"]);
  }, silent);
  const outputRoot = join(root, "target", "check-artifacts");
  const debug = join(outputRoot, readdirSync(outputRoot)[0], "debug");
  assert.deepEqual(readdirSync(debug), ["oxide-app.exe"]);
});

for (const status of [0, 1]) test(`the real runner cleans a compiler's files after exit ${status}`, { skip: !["win32", "darwin"].includes(process.platform) }, (t) => {
  const root = fixture(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const report = join(root, "target-used.txt");
  const windows = process.platform === "win32";
  writeFileSync(join(bin, windows ? "cargo.cmd" : "cargo"), windows
    ? `@echo off\r\nmkdir "%CARGO_TARGET_DIR%\\debug"\r\necho temporary > "%CARGO_TARGET_DIR%\\debug\\cache.pdb"\r\necho %CARGO_TARGET_DIR%> "%OXIDE_TEST_REPORT%"\r\nexit /b ${status}\r\n`
    : `#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/debug"\nprintf temporary > "$CARGO_TARGET_DIR/debug/cache.pdb"\nprintf '%s' "$CARGO_TARGET_DIR" > "$OXIDE_TEST_REPORT"\nexit ${status}\n`,
    { mode: 0o755 });
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("../../tools/checks/run.mjs", import.meta.url)), "clippy"], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CARGO_TARGET_DIR: join(root, "target"), OXIDE_TEST_REPORT: report, OXIDE_BUILD_BUDGET_GIB: "12" },
  });
  assert.equal(run.status, status, run.stderr);
  const scratch = readFileSync(report, "utf8").trim();
  assert.equal(existsSync(scratch), false);
  assert.match(run.stdout, /Temporary Rust build files cleaned/);
  assert.equal(readFileSync(join(root, "target", "running-app.exe"), "utf8"), "keep existing output");
});
