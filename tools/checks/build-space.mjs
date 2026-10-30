import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const GiB = 1024 ** 3;
const warnedTargets = new Set();

/** Read-only, bounded traversal: stop counting at the budget, never follow links. */
export function buildBytes(directory, limitBytes = Infinity) {
  let bytes = 0;
  const seen = new Set();
  const pending = [directory];
  while (pending.length && bytes <= limitBytes) {
    const path = pending.pop();
    let info;
    try { info = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) pending.push(join(path, entry));
    } else if (info.isFile()) {
      // Cargo hard-links final outputs into deps; count the underlying file once.
      const key = `${info.dev}:${info.ino}`;
      if (!seen.has(key)) bytes += info.size;
      seen.add(key);
    }
  }
  return bytes;
}

export function compilesRust(command) {
  return (command[0] === "cargo" && ["build", "check", "clippy", "test", "nextest", "rustc"].includes(command[1])) ||
    /(?:^|[/\\])tauri(?:\.cmd)?$/.test(command[0]) && command.includes("build");
}

export function assertBuildSpace(repoRoot, env = process.env, warn = console.warn) {
  const budget = Number(env.OXIDE_BUILD_BUDGET_GIB ?? 12);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("OXIDE_BUILD_BUDGET_GIB must be a positive number.");
  const target = resolve(repoRoot, env.CARGO_TARGET_DIR ?? "target");
  if (buildBytes(target, budget * GiB) <= budget * GiB) return;
  const message = `Build artifacts exceed ${budget} GiB at ${target}.`;
  if (env.OXIDE_BUILD_BUDGET_GIB !== undefined) {
    throw new Error(`${message} Stopping local checks at the configured disk budget. Inspect unused build configurations or raise OXIDE_BUILD_BUDGET_GIB to keep reusing this cache.`);
  }
  if (!warnedTargets.has(target)) {
    warn(`${message} Compiler cache retained for reuse. OXIDE_BUILD_BUDGET_GIB sets an optional hard limit; cargo clean discards the cache and forces a full rebuild.`);
    warnedTargets.add(target);
  }
}
