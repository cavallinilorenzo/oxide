// A tiny, deterministic runtime release built with the same primitives the release pipeline
// uses and a throwaway test key (public on purpose: it signs nothing but this fixture). The
// Rust test crates/oxide-core/tests/dictation_runtimes_ci.rs feeds these exact bytes to the
// core; runtime-fixture.test.mjs fails when they stop matching what the tools produce.
//
//   node tools/checks/runtime-fixture.mjs write    regenerate crates/oxide-core/tests/fixtures/runtimes/
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_BACKENDS, runtimeAssetName, runtimeIndex, runtimePackageManifest } from "../ci/policy.mjs";
import { publicKeyOf, signMinisign, zipFlat } from "./runtime-release.mjs";

export const FIXTURE_DIR = fileURLToPath(new URL("../../crates/oxide-core/tests/fixtures/runtimes/", import.meta.url));
export const FIXTURE_TAG = "v0.0.1";
export const FIXTURE_REPOSITORY = "example/oxide";
// base64(key id[8] || seed[32]): only for this fixture.
export const FIXTURE_SECRET_KEY = Buffer.concat([Buffer.from("fixture!"), Buffer.alloc(32, 7)]).toString("base64");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** `{ file name: Buffer }` for the public key, two packages, the index and its signature. */
export function buildFixture() {
  const version = FIXTURE_TAG.slice(1);
  const files = {};
  const packages = [];
  for (const [backend, spec] of Object.entries(RUNTIME_BACKENDS)) {
    const content = Object.fromEntries([spec.worker, ...spec.dlls, ...spec.licenses].map((name) => [name, Buffer.from(`${backend}:${name}\n`)]));
    const manifest = runtimePackageManifest({
      backend, version, hashes: Object.fromEntries(Object.entries(content).map(([name, body]) => [name, sha256(body)])),
    });
    const zip = zipFlat([...Object.entries(content), ["manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]);
    files[runtimeAssetName(backend, version)] = zip;
    packages.push({ backend, bytes: zip.length, sha256: sha256(zip) });
  }
  const index = Buffer.from(`${JSON.stringify(runtimeIndex(packages, { repository: FIXTURE_REPOSITORY, tag: FIXTURE_TAG }), null, 2)}\n`);
  files["runtimes-index.json"] = index;
  files["runtimes-index.json.minisig"] = Buffer.from(signMinisign(FIXTURE_SECRET_KEY, index, `oxide runtimes ${FIXTURE_TAG}`));
  files["public-key.txt"] = Buffer.from(`${publicKeyOf(FIXTURE_SECRET_KEY)}\n`);
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "write") {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [name, body] of Object.entries(buildFixture())) writeFileSync(join(FIXTURE_DIR, name), body);
  console.log(`Wrote ${FIXTURE_DIR}`);
}
