import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReleaseVersion } from "./release-version.mjs";

const cargoToml = (version) => `[workspace]
resolver = "3"
members = ["crates/a"]

[workspace.package]
version = "${version}"
edition = "2024"
`;

const sources = ({ cargo = "0.2.0", tauri = "0.2.0", web = "0.2.0" } = {}) => ({
  cargoToml: cargoToml(cargo),
  tauriConf: JSON.stringify({ productName: "Oxide", version: tauri }),
  webPackage: JSON.stringify({ name: "oxide-web", version: web }),
});

test("passes when the tag matches all three declared versions", () => {
  const result = checkReleaseVersion({ tag: "v0.2.0", ...sources() });
  assert.equal(result.ok, true);
});

test("fails when the tag disagrees with the declared version", () => {
  const result = checkReleaseVersion({ tag: "v0.3.0", ...sources() });
  assert.equal(result.ok, false);
  assert.match(result.message, /v0\.3\.0/);
  assert.match(result.message, /Cargo\.toml 0\.2\.0/);
});

test("fails and names the one manifest that was not bumped", () => {
  const result = checkReleaseVersion({ tag: "v0.2.0", ...sources({ tauri: "0.1.0" }) });
  assert.equal(result.ok, false);
  assert.match(result.message, /tauri\.conf\.json 0\.1\.0/);
  assert.doesNotMatch(result.message, /package\.json/);
});

test("accepts a pre-release tag that matches exactly", () => {
  const result = checkReleaseVersion({ tag: "v0.2.0-rc.1", ...sources({ cargo: "0.2.0-rc.1", tauri: "0.2.0-rc.1", web: "0.2.0-rc.1" }) });
  assert.equal(result.ok, true);
});

test("rejects a tag that is not vX.Y.Z", () => {
  const result = checkReleaseVersion({ tag: "0.2.0", ...sources() });
  assert.equal(result.ok, false);
  assert.match(result.message, /vX\.Y\.Z/);
});
