import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const GiB = 1024 ** 3;

/** Read-only, bounded traversal: stop counting at the budget, never follow links. */
export function buildBytes(directory, limitBytes = Infinity) {
  let bytes = 0;
  const pending = [directory];
  while (pending.length && bytes <= limitBytes) {
    const path = pending.pop();
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) pending.push(join(path, entry));
    } else if (info.isFile()) bytes += info.size;
  }
  return bytes;
}

export function compilesRust(command) {
  return (command[0] === "cargo" && ["build", "check", "clippy", "test", "nextest", "rustc"].includes(command[1])) ||
    /(?:^|[/\\])tauri(?:\.cmd)?$/.test(command[0]) && command.includes("build");
}

export function assertBuildSpace(repoRoot, env = process.env) {
  const budget = Number(env.OXIDE_BUILD_BUDGET_GIB ?? 12);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("OXIDE_BUILD_BUDGET_GIB must be a positive number.");
  const target = resolve(repoRoot, env.CARGO_TARGET_DIR ?? "target");
  if (buildBytes(target, budget * GiB) > budget * GiB) throw new Error(
    `Build artifacts exceed ${budget} GiB at ${target}. Stopping local checks to avoid further growth. Run cargo clean for this target directory before rebuilding; close a locally built app first if Windows reports a locked executable. OXIDE_BUILD_BUDGET_GIB sets the local budget.`,
  );
}
