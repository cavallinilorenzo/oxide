import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBuildSession } from "./build-session.mjs";

const silent = () => {};
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oxide-build-session-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("successive checks and app builds reuse the default Cargo cache", (t) => {
  const root = fixture(t);
  const target = join(root, "target");
  const result = withBuildSession(root, { CUSTOM_VALUE: "kept" }, (session) => {
    assert.equal(session.env.CUSTOM_VALUE, "kept");
    assert.equal(session.env.CARGO_TARGET_DIR, target);
    mkdirSync(join(session.target, "debug", "deps"), { recursive: true });
    writeFileSync(join(session.target, "debug", "deps", "dependency.rlib"), "compiled dependency");
    return 42;
  }, silent);
  assert.equal(result, 42);
  withBuildSession(root, {}, (session) => {
    assert.equal(session.target, target);
    assert.equal(readFileSync(join(session.target, "debug", "deps", "dependency.rlib"), "utf8"), "compiled dependency");
  }, silent);
  assert.deepEqual(readdirSync(target), ["debug"]);
});

test("failures retain compiled dependencies for the next attempt", (t) => {
  const root = fixture(t);
  assert.equal(withBuildSession(root, {}, (session) => {
    writeFileSync(join(session.target, "dependency.rlib"), "reusable");
    return 1;
  }, silent), 1);
  assert.throws(() => withBuildSession(root, {}, () => {
    throw new Error("Build failed");
  }, silent), /Build failed/);
  withBuildSession(root, {}, (session) => {
    assert.equal(readFileSync(join(session.target, "dependency.rlib"), "utf8"), "reusable");
  }, silent);
});

test("explicit relative and absolute Cargo targets are reused directly", (t) => {
  const root = fixture(t);
  const target = join(root, "custom");
  const inherited = { CARGO_TARGET_DIR: "custom" };
  withBuildSession(root, inherited, (session) => {
    assert.equal(session.target, target);
    writeFileSync(join(session.target, "dependency.rlib"), "reusable");
  }, silent);
  withBuildSession(root, { CARGO_TARGET_DIR: target }, (session) => {
    assert.equal(readFileSync(join(session.target, "dependency.rlib"), "utf8"), "reusable");
  }, silent);
  assert.equal(inherited.CARGO_TARGET_DIR, "custom");
  assert.equal(existsSync(join(root, "target")), false);
});

test("successful bundles stay in Cargo's output directory without per-run copies", (t) => {
  const root = fixture(t);
  const messages = [];
  withBuildSession(root, {}, (session) => {
    const release = join(session.target, "aarch64-apple-darwin", "release");
    mkdirSync(join(release, "bundle"), { recursive: true });
    writeFileSync(join(release, "bundle", "Oxide.dmg"), "installer");
    writeFileSync(join(release, "oxide-app"), "binary");
    session.reportOutputs(["web/node_modules/.bin/tauri", "build", "--target", "aarch64-apple-darwin"]);
    assert.ok(messages.some((message) => message.includes(release)));
  }, (message) => messages.push(message));
  assert.equal(readFileSync(join(root, "target", "aarch64-apple-darwin", "release", "bundle", "Oxide.dmg"), "utf8"), "installer");
  assert.deepEqual(readdirSync(join(root, "target")), ["aarch64-apple-darwin"]);
});

test("debug and custom-profile app builds report their actual output directory", (t) => {
  const root = fixture(t);
  for (const [flags, profile] of [[ ["--debug"], "debug" ], [ ["--profile=custom"], "custom" ]]) {
    const messages = [];
    withBuildSession(root, {}, (session) => {
      const output = join(session.target, profile);
      mkdirSync(output);
      writeFileSync(join(output, "oxide-app.exe"), "binary");
      session.reportOutputs(["tauri", "build", ...flags]);
      assert.ok(messages.some((message) => message.includes(output)));
    }, (message) => messages.push(message));
  }
});

test("overlapping sessions share the cache and never clean another build's files", (t) => {
  const root = fixture(t);
  withBuildSession(root, {}, (outer) => {
    writeFileSync(join(outer.target, "still-building.o"), "active");
    withBuildSession(root, {}, (inner) => {
      assert.equal(inner.target, outer.target);
    }, silent);
    assert.equal(readFileSync(join(outer.target, "still-building.o"), "utf8"), "active");
  }, silent);
});

test("missing final outputs report an error while retaining the cache", (t) => {
  const root = fixture(t);
  assert.throws(() => withBuildSession(root, {}, (session) => {
    writeFileSync(join(session.target, "dependency.rlib"), "reusable");
    session.reportOutputs(["tauri", "build"]);
  }, silent), /No final app binary or bundle.*cache retained/);
  assert.equal(readFileSync(join(root, "target", "dependency.rlib"), "utf8"), "reusable");
});
