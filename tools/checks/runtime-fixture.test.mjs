import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embeddedPublicKey, verifyRelease } from "../dictation-runtimes.mjs";
import { buildFixture, FIXTURE_DIR } from "./runtime-fixture.mjs";
import { generateSigningKey, signMinisign } from "./runtime-release.mjs";

// The fixture's "executables" are text, so their imports are stubbed.
const options = { importsOf: () => ["KERNEL32.dll"] };
const publicKey = () => readFileSync(join(FIXTURE_DIR, "public-key.txt"), "utf8").trim();
const copyOfFixture = () => {
  const copy = mkdtempSync(join(tmpdir(), "oxide-runtime-fixture-"));
  cpSync(FIXTURE_DIR, copy, { recursive: true });
  return copy;
};

test("the committed fixture is what the release tools produce today", () => {
  const built = buildFixture();
  assert.deepEqual(readdirSync(FIXTURE_DIR).sort(), Object.keys(built).sort());
  for (const [name, body] of Object.entries(built)) {
    assert.ok(readFileSync(join(FIXTURE_DIR, name)).equals(body), `${name} is stale: run node tools/checks/runtime-fixture.mjs write`);
  }
});

test("the release verifier accepts the fixture, and refuses a stale index or the wrong key", () => {
  assert.deepEqual(verifyRelease(FIXTURE_DIR, "v0.0.1", publicKey(), options), []);
  assert.match(verifyRelease(FIXTURE_DIR, "v0.0.2", publicKey(), options)[0], /not v0\.0\.2/);
  assert.match(verifyRelease(FIXTURE_DIR, "v0.0.1", generateSigningKey().publicKey, options)[0], /not a valid signature/);
});

test("a package that no longer matches the signed index is refused", () => {
  const copy = copyOfFixture();
  const cuda = readdirSync(copy).find((name) => name.includes("cuda"));
  const bytes = readFileSync(join(copy, cuda));
  bytes[bytes.length - 30] ^= 1;
  writeFileSync(join(copy, cuda), bytes);
  assert.ok(verifyRelease(copy, "v0.0.1", publicKey(), options).some((problem) => problem.includes(cuda)));
});

test("an index signed with another key is refused even when it is well formed", () => {
  const copy = copyOfFixture();
  const impostor = generateSigningKey();
  writeFileSync(join(copy, "runtimes-index.json.minisig"), signMinisign(impostor.secretKey, readFileSync(join(copy, "runtimes-index.json")), "x"));
  assert.match(verifyRelease(copy, "v0.0.1", publicKey(), options)[0], /not a valid signature/);
});

test("the key embedded in the app is a minisign public key", () => {
  const key = Buffer.from(embeddedPublicKey(), "base64");
  assert.equal(key.length, 42);
  assert.equal(key.subarray(0, 2).toString(), "Ed");
});
