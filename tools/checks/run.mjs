// Local entry point for the Check catalogue.
//
//   node tools/checks/run.mjs fast          formatting, lint, typecheck
//   node tools/checks/run.mjs pr            everything the PR gate runs on this platform
//   node tools/checks/run.mjs <check-id>    a single check
//   node tools/checks/run.mjs --list        every check with its tiers
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { plan, validateCatalogue } from "./catalogue.mjs";
import { assertBuildSpace, compilesRust } from "./build-space.mjs";
import { withBuildSession } from "./build-session.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const catalogue =JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
const problems = validateCatalogue(catalogue);
if (problems.length > 0) {
  console.error(`Invalid catalogue:\n- ${problems.join("\n- ")}`);
  process.exit(2);
}

const target = process.argv[2];
if (!target || target === "--list") {
  for (const check of catalogue.checks) console.log(`${check.id.padEnd(20)} [${check.tiers.join(",")}] ${check.name}`);
  process.exit(target ? 0 : 2);
}

const platform = { darwin: "macos", win32: "windows" }[process.platform] ?? "linux";
let result;
try {
  result = plan(catalogue, { target, platform, event: "local" });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

for (const { check, reason } of result.skipped) console.log(`skip  ${check.id}: ${reason}`);
if (result.run.length === 0) {
  // An explicitly requested check that cannot run here must not look green.
  console.error(`Nothing to run for "${target}" on this platform.`);
  process.exit(1);
}

const failures = [];
let completed = 0;
const runChecks = (session) => {
  for (const { check } of result.run) {
    if (compilesRust(check.command)) assertBuildSpace(repoRoot);
    console.log(`\n> ${check.id}: ${check.command.join(" ")}`);
    // All checks share one scratch target, including Tauri and generated bindings.
    const run = spawnSync(check.command[0], check.command.slice(1), {
      stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32", env: session?.env ?? process.env,
    });
    completed++;
    if (run.status !== 0) failures.push(check);
    else session?.preserve(check.command);
    if (compilesRust(check.command)) assertBuildSpace(repoRoot);
  }
};
let lifecycleFailed = false;
try {
  if (result.run.some(({ check }) => compilesRust(check.command))) {
    assertBuildSpace(repoRoot);
    withBuildSession(repoRoot, process.env, runChecks);
  } else runChecks();
} catch (error) {
  lifecycleFailed = true;
  console.error(error.message);
}

console.log(`\n${completed - failures.length} passed, ${failures.length} failed, ${result.skipped.length} skipped, ${result.run.length - completed} not run`);
for (const check of failures) console.log(`FAILED ${check.id} — rerun with: node tools/checks/run.mjs ${check.id}`);
process.exitCode = lifecycleFailed || failures.length > 0 ? 1 : 0;
