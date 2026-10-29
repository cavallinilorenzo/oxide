// Local runner: what the PR lanes run on this OS, with the same commands as CI.
//
//   node tools/check.mjs          everything the PR lanes run here (the full tier)
//   node tools/check.mjs fast     rustfmt, ESLint and TypeScript, in seconds
//
// It says what it can't run here and why, and prints every failed command.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBuildSpace, compilesRust } from "./checks/build-space.mjs";
import { withBuildSession } from "./checks/build-session.mjs";
import { commandLine, localPlan } from "./ci/policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const windows = process.platform === "win32";
let plan;
try {
  plan = localPlan(process.platform, process.argv[2] ?? "pr");
} catch (error) {
  console.error(`${error.message}\nUsage: node tools/check.mjs [fast|pr]`);
  process.exit(2);
}

const exec = (command, env = process.env) =>
  // cmd.exe, needed for .cmd shims on Windows, reads "/" in a program path as a switch.
  spawnSync(windows ? command[0].replaceAll("/", "\\") : command[0], command.slice(1), {
    cwd: repoRoot, stdio: "inherit", env, shell: windows,
  });

if (plan.run.some(({ command }) => command[1] === "nextest") &&
    spawnSync("cargo", ["nextest", "--version"], { stdio: "ignore", shell: windows }).status !== 0) {
  console.error("cargo-nextest is required, as in CI. Install it with: cargo install --locked cargo-nextest");
  process.exit(1);
}

for (const { id, reason } of plan.skipped) console.log(`skip  ${id}: ${reason}`);

const failures = [];
let completed = 0;
const runChecks = (session) => {
  for (const { id, command } of plan.run) {
    if (compilesRust(command)) assertBuildSpace(repoRoot);
    console.log(`\n> ${id}: ${commandLine(command)}`);
    // All checks share one scratch target, including Tauri and the generated bindings.
    const result = exec(command, session?.env);
    if (result.error) console.error(`Cannot start ${command[0]}: ${result.error.message}`);
    completed++;
    if (result.status !== 0) failures.push({ id, command });
    else session?.preserve(command);
    if (compilesRust(command)) assertBuildSpace(repoRoot);
  }
};

let lifecycleFailed = false;
try {
  if (plan.run.some(({ command }) => compilesRust(command))) {
    assertBuildSpace(repoRoot);
    withBuildSession(repoRoot, process.env, runChecks);
  } else runChecks();
} catch (error) {
  lifecycleFailed = true;
  console.error(error.message);
}

console.log(`\n${completed - failures.length} passed, ${failures.length} failed, ${plan.skipped.length} skipped, ${plan.run.length - completed} not run`);
for (const { id, command } of failures) console.log(`FAILED ${id}: ${commandLine(command)}`);
process.exitCode = lifecycleFailed || failures.length > 0 ? 1 : 0;
