import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMerge } from "./dependabot-policy.mjs";

// Shape of one entry in dependabot/fetch-metadata's `updated-dependencies-json`.
const dep = (dependencyName, updateType, prevVersion, newVersion, dependencyGroup = "") => ({
  dependencyName,
  dependencyType: "direct:production",
  updateType: `version-update:semver-${updateType}`,
  prevVersion,
  newVersion,
  dependencyGroup,
});

test("auto-merges a patch update", () => {
  assert.equal(decideMerge([dep("serde", "patch", "1.0.228", "1.0.229")]).decision, "auto");
});

test("auto-merges a minor update of a 1.x package", () => {
  assert.equal(decideMerge([dep("react", "minor", "19.2.0", "19.3.1")]).decision, "auto");
});

test("auto-merges a grouped PR when every update is low-risk", () => {
  const deps = [
    dep("vite", "minor", "8.2.0", "8.3.5", "build-test"),
    dep("vitest", "patch", "5.0.4", "5.0.5", "build-test"),
  ];
  assert.equal(decideMerge(deps).decision, "auto");
});

test("auto-merges a GitHub Actions minor bump with a v-prefixed version", () => {
  assert.equal(decideMerge([dep("actions/checkout", "minor", "v7.0.1", "v7.1.0", "actions")]).decision, "auto");
});

test("holds a major update for manual review", () => {
  const result = decideMerge([dep("eslint", "major", "10.13.0", "11.0.0")]);
  assert.equal(result.decision, "manual");
  assert.match(result.reason, /eslint.*major/);
});

test("holds a minor update of a 0.x package, which is breaking under semver", () => {
  const result = decideMerge([dep("portable-pty", "minor", "0.9.0", "0.10.0")]);
  assert.equal(result.decision, "manual");
  assert.match(result.reason, /portable-pty.*0\.x/);
});

test("holds a patch update of a 0.0.x package, which is breaking under caret ranges", () => {
  assert.equal(decideMerge([dep("some-crate", "patch", "0.0.13", "0.0.14")]).decision, "manual");
});

test("still auto-merges a patch update of a 0.x package", () => {
  assert.equal(decideMerge([dep("objc2", "patch", "0.6.1", "0.6.2")]).decision, "auto");
});

test("holds the whole group when one update in it is risky", () => {
  const deps = [
    dep("vite", "patch", "8.3.4", "8.3.5", "build-test"),
    dep("@vitejs/plugin-react", "major", "6.1.2", "7.0.0", "build-test"),
  ];
  assert.equal(decideMerge(deps).decision, "manual");
});

for (const group of ["tauri", "specta"]) {
  test(`holds the ${group} group even for a patch update`, () => {
    const result = decideMerge([dep(`${group}-thing`, "patch", "2.12.4", "2.12.5", group)]);
    assert.equal(result.decision, "manual");
    assert.match(result.reason, new RegExp(`${group} group`));
  });
}

test("holds an update whose type Dependabot could not determine", () => {
  const result = decideMerge([{ ...dep("mystery", "patch", "", "1.0.0"), updateType: "" }]);
  assert.equal(result.decision, "manual");
});

test("holds a minor update when the previous version is unknown", () => {
  assert.equal(decideMerge([dep("mystery", "minor", "", "1.3.0")]).decision, "manual");
});

test("holds a PR with no parsable dependencies", () => {
  assert.equal(decideMerge([]).decision, "manual");
});
