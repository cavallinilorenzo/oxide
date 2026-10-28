// Local entry point for the Check catalogue.
//
//   node tools/checks/run.mjs fast          formatting, lint, typecheck
//   node tools/checks/run.mjs pr            everything the PR gate runs on this platform
//   node tools/checks/run.mjs <check-id>    a single check
//   node tools/checks/run.mjs --list        every check with its tiers
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { plan, validateCatalogue } from "./catalogue.mjs";

const catalogue = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
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

const failures = [];
for (const { check } of result.run) {
  console.log(`\n> ${check.id}: ${check.command.join(" ")}`);
  // Windows resolves pnpm/tauri shims only through the shell.
  const run = spawnSync(check.command[0], check.command.slice(1), { stdio: "inherit", shell: process.platform === "win32" });
  if (run.status !== 0) failures.push(check);
}

console.log(`\n${result.run.length - failures.length} passed, ${failures.length} failed, ${result.skipped.length} skipped`);
for (const check of failures) console.log(`FAILED ${check.id} — rerun with: node tools/checks/run.mjs ${check.id}`);
process.exit(failures.length > 0 ? 1 : 0);
