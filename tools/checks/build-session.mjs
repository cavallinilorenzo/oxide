import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function argument(command, flag) {
  const inline = command.find((part) => part.startsWith(`${flag}=`));
  const value = inline ? inline.slice(flag.length + 1) : command[command.indexOf(flag) + 1];
  if (!inline && !command.includes(flag)) return null;
  if (!value || value === "." || value === ".." || !/^[\w.-]+$/.test(value)) throw new Error(`Unsupported ${flag} for build artifact preservation.`);
  return value;
}

/** Own one scratch target. Never clean a shared target or an existing app binary. */
export function withBuildSession(repoRoot, env, run, log = console.log) {
  const base = resolve(repoRoot, env.CARGO_TARGET_DIR ?? "target");
  mkdirSync(base, { recursive: true });
  const canonicalBase = realpathSync(base);
  const target = mkdtempSync(join(canonicalBase, ".oxide-checks-"));
  const original = lstatSync(target);
  let retainForRecovery = false;
  const session = {
    target,
    env: { ...env, CARGO_TARGET_DIR: target },
    preserve(command) {
      if (!/(?:^|[/\\])tauri(?:\.cmd)?$/.test(command[0]) || !command.includes("build")) return;
      try {
        const triple = argument(command, "--target");
        const profile = argument(command, "--profile") ?? (command.includes("--debug") ? "debug" : "release");
        const parts = [...(triple ? [triple] : []), profile];
        const source = join(target, ...parts);
        const destination = join(canonicalBase, "check-artifacts", basename(target).replace(".oxide-checks-", "run-"), ...parts);
        const outputs = ["bundle", "oxide-app", "oxide-app.exe"].filter((name) => existsSync(join(source, name)));
        if (outputs.length === 0) throw new Error("No final app binary or bundle was found.");
        mkdirSync(destination, { recursive: true });
        for (const name of outputs) cpSync(join(source, name), join(destination, name), { recursive: true, verbatimSymlinks: true });
        log(`Final build outputs saved to ${destination}`);
      } catch (error) {
        // An output-copy failure must not destroy the only copy of the finished app.
        retainForRecovery = true;
        throw new Error(`Cannot preserve final build outputs. Scratch files kept at ${target}: ${error.message}`, { cause: error });
      }
    },
  };
  log(`Temporary Rust build directory: ${target}`);
  try {
    return run(session);
  } finally {
    if (!retainForRecovery && existsSync(target)) {
      const current = lstatSync(target);
      if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev ||
          realpathSync(target) !== target || dirname(target) !== canonicalBase || !basename(target).startsWith(".oxide-checks-")) {
        throw new Error(`Refusing to clean a replaced build directory: ${target}`);
      }
      // This is the verified directory created above, not the caller's target root.
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      log("Temporary Rust build files cleaned.");
    }
  }
}
