import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTauriAlignment } from "./tauri-alignment.mjs";

const cargoLock = (tauri) => `
[[package]]
name = "tauri"
version = "${tauri}"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-build"
version = "9.9.9"
`;

const pnpmLock = (api, cli) => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@tauri-apps/api':
        specifier: ^2.0.0
        version: ${api}
    devDependencies:
      '@tauri-apps/cli':
        specifier: ^2.0.0
        version: ${cli}

packages:

  '@tauri-apps/api@0.0.1':
    resolution: {integrity: sha512-x}
`;

test("passes when the crate and both JS packages share major.minor", () => {
  const result = checkTauriAlignment({
    cargoLock: cargoLock("2.12.5"),
    pnpmLock: pnpmLock("2.12.4", "2.12.3"),
  });
  assert.equal(result.ok, true);
});

test("fails when @tauri-apps/api is on a different minor", () => {
  const result = checkTauriAlignment({
    cargoLock: cargoLock("2.12.5"),
    pnpmLock: pnpmLock("2.13.0", "2.12.3"),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /@tauri-apps\/api 2\.13\.0/);
});

test("fails when @tauri-apps/cli is on a different major", () => {
  const result = checkTauriAlignment({
    cargoLock: cargoLock("2.12.5"),
    pnpmLock: pnpmLock("2.12.4", "3.0.0"),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /@tauri-apps\/cli 3\.0\.0/);
});

test("fails loudly when a package is missing from a lockfile", () => {
  const result = checkTauriAlignment({
    cargoLock: "",
    pnpmLock: pnpmLock("2.12.4", "2.12.3"),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /tauri.*not found in Cargo\.lock/);
});
