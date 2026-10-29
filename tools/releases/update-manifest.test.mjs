import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateManifest } from "./update-manifest.mjs";

test("publishes the signed native packages with correct updater platform keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxide-feed-"));
  try {
    for (const file of ["Oxide.app.tar.gz", "Oxide_1.2.3_x64-setup.exe"]) {
      writeFileSync(join(dir, file), "package");
      writeFileSync(join(dir, file + ".sig"), "test-signature\n");
    }
    const feed = updateManifest(dir, { repository: "cavallinilorenzo/oxide", tag: "v1.2.3", date: "2026-10-29T00:00:00Z" });
    assert.equal(feed.version, "1.2.3");
    assert.deepEqual(Object.keys(feed.platforms), ["darwin-aarch64", "windows-x86_64"]);
    assert.equal(feed.platforms["windows-x86_64"].signature, "test-signature");
    assert.equal(feed.platforms["darwin-aarch64"].url, "https://github.com/cavallinilorenzo/oxide/releases/download/v1.2.3/Oxide.app.tar.gz");
    writeFileSync(join(dir, "Oxide.app.tar.gz.sig"), "");
    assert.throws(() => updateManifest(dir, { repository: "cavallinilorenzo/oxide", tag: "v1.2.3" }), /Empty signature/);
    assert.throws(() => updateManifest(dir, { repository: "invalid", tag: "v1.2.3" }), /identity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses unsigned or missing packages, and allows a release for one platform", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxide-feed-"));
  try {
    assert.throws(() => updateManifest(dir, { repository: "cavallinilorenzo/oxide", tag: "v1.2.3" }), /No supported/);
    writeFileSync(join(dir, "Oxide.app.tar.gz"), "package");
    assert.throws(() => updateManifest(dir, { repository: "cavallinilorenzo/oxide", tag: "v1.2.3" }), /Missing signature/);
    writeFileSync(join(dir, "Oxide.app.tar.gz.sig"), "test-signature");
    assert.deepEqual(Object.keys(updateManifest(dir, { repository: "cavallinilorenzo/oxide", tag: "v1.2.3" }).platforms), ["darwin-aarch64"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
