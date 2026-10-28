import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { conformance, evaluateGate, plan, validateCatalogue } from "./catalogue.mjs";

const check = (over) => ({
  id: "a",
  name: "A",
  why: "Prevents A from breaking.",
  command: ["echo", "a"],
  tiers: ["pr"],
  platforms: ["macos", "windows", "linux"],
  blocking: true,
  tools: {},
  ...over,
});

const catalogue = {
  checks: [
    check({ id: "fmt", tiers: ["fast", "pr"] }),
    check({ id: "clippy", platforms: ["macos", "windows"] }),
    check({ id: "bundle", platforms: ["macos"] }),
    check({ id: "pr-title", events: ["pull_request"], command: null }),
    check({ id: "advisories", tiers: ["daily"] }),
  ],
};

const ids = (list) => list.map((entry) => entry.check.id);

test("pr tier on Windows runs clippy, skips the bundle as macOS only", () => {
  const result = plan(catalogue, { target: "pr", platform: "windows", event: "local" });
  assert.deepEqual(ids(result.run), ["fmt", "clippy"]);
  const bundle = result.skipped.find((entry) => entry.check.id === "bundle");
  assert.match(bundle.reason, /macOS only/);
});

test("checks that need GitHub or another event are skipped with a reason", () => {
  const result = plan(catalogue, { target: "pr", platform: "macos", event: "local" });
  const title = result.skipped.find((entry) => entry.check.id === "pr-title");
  assert.match(title.reason, /pull_request/);
});

test("fast tier contains only fast checks", () => {
  const result = plan(catalogue, { target: "fast", platform: "macos", event: "local" });
  assert.deepEqual(ids(result.run), ["fmt"]);
});

test("a single check runs by id, whatever its tier", () => {
  const result = plan(catalogue, { target: "advisories", platform: "linux", event: "local" });
  assert.deepEqual(ids(result.run), ["advisories"]);
});

test("an unknown target names the valid ones", () => {
  assert.throws(
    () => plan(catalogue, { target: "nope", platform: "linux", event: "local" }),
    /fmt.*clippy.*fast.*pr/s,
  );
});

test("validateCatalogue rejects empty why and duplicate ids", () => {
  const bad = { checks: [check({ why: " " }), check({})] };
  const problems = validateCatalogue(bad);
  assert.ok(problems.some((p) => /"a".*why/.test(p)));
  assert.ok(problems.some((p) => /duplicate/.test(p)));
});

const withJobs = {
  checks: [
    check({ id: "lint", job: { workflow: "ci.yml", id: "lint" } }),
    check({ id: "bundle", job: { workflow: "ci.yml", id: "bundle" }, platforms: ["macos"] }),
    check({ id: "fmt", tiers: ["fast"] }),
  ],
};
const ciWorkflow = (jobs, needs = ["lint", "bundle"]) => ({
  file: "ci.yml",
  doc: { jobs: { ...jobs, gate: { needs } } },
});
const guide = "### `lint`\n### `bundle`\n### `fmt`\n";
const okJobs = { lint: {}, bundle: {} };

test("conformance passes when workflows, gate and guide agree", () => {
  assert.deepEqual(conformance({ catalogue: withJobs, workflows: [ciWorkflow(okJobs)], guide }), []);
});

test("conformance reports a job with no catalogue entry", () => {
  const problems = conformance({
    catalogue: withJobs,
    workflows: [ciWorkflow({ ...okJobs, mystery: {} }, ["lint", "bundle", "mystery"])],
    guide,
  });
  assert.deepEqual(problems, ["ci.yml job \"mystery\" has no catalogue entry"]);
});

test("conformance reports a blocking job missing from gate needs", () => {
  const problems = conformance({ catalogue: withJobs, workflows: [ciWorkflow(okJobs, ["lint"])], guide });
  assert.deepEqual(problems, ["check \"bundle\" is blocking but ci.yml job \"bundle\" is not in gate needs"]);
});

test("conformance reports a check no workflow runs", () => {
  const problems = conformance({ catalogue: withJobs, workflows: [ciWorkflow({ lint: {} }, ["lint"])], guide });
  assert.ok(problems.some((p) => /"bundle".*no workflow/.test(p)));
});

test("conformance reports a non-fast check without a job", () => {
  const catalogueNoJob = { checks: [check({ id: "orphan" })] };
  const problems = conformance({ catalogue: catalogueNoJob, workflows: [], guide: "### `orphan`" });
  assert.ok(problems.some((p) => /"orphan".*no workflow/.test(p)));
});

test("conformance reports an empty why and a missing guide section", () => {
  const broken = { checks: [...withJobs.checks.slice(0, 2), check({ id: "fmt", tiers: ["fast"], why: "" })] };
  const problems = conformance({ catalogue: broken, workflows: [ciWorkflow(okJobs)], guide: "### `lint`\n### `bundle`" });
  assert.ok(problems.some((p) => /"fmt".*why/.test(p)));
  assert.ok(problems.some((p) => /"fmt".*guide/.test(p)));
});

test("the real catalogue is valid", () => {
  const real = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
  assert.deepEqual(validateCatalogue(real), []);
});

const skippedOn = { "pr-title": ["push"] };

test("gate passes when every job succeeded", () => {
  const result = evaluateGate({ results: { rust: "success", lint: "success" }, event: "pull_request", skippedOn });
  assert.equal(result.ok, true);
});

test("gate fails naming a failed, cancelled or unexpectedly skipped job", () => {
  for (const bad of ["failure", "cancelled", "skipped"]) {
    const result = evaluateGate({ results: { rust: "success", lint: bad }, event: "pull_request", skippedOn });
    assert.equal(result.ok, false);
    assert.match(result.message, /lint/);
  }
});

test("gate accepts pr-title skipped on push, but not on a pull request", () => {
  const results = { lint: "success", "pr-title": "skipped" };
  assert.equal(evaluateGate({ results, event: "push", skippedOn }).ok, true);
  assert.equal(evaluateGate({ results, event: "pull_request", skippedOn }).ok, false);
});
