import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

function argument(command, flag) {
  const inline = command.find((part) => part.startsWith(`${flag}=`));
  const value = inline ? inline.slice(flag.length + 1) : command[command.indexOf(flag) + 1];
  if (!inline && !command.includes(flag)) return null;
  if (!value || value === "." || value === ".." || !/^[\w.-]+$/.test(value)) throw new Error(`Unsupported ${flag} for build output reporting.`);
  return value;
}

/** Share Cargo's persistent target across checks, app builds and direct invocations. */
export function withBuildSession(repoRoot, env, run, log = console.log) {
  const base = resolve(repoRoot, env.CARGO_TARGET_DIR ?? "target");
  mkdirSync(base, { recursive: true });
  const target = realpathSync(base);
  const session = {
    target,
    env: { ...env, CARGO_TARGET_DIR: target },
    reportOutputs(command) {
      if (!/(?:^|[/\\])tauri(?:\.cmd)?$/.test(command[0]) || !command.includes("build")) return;
      const triple = argument(command, "--target");
      const profile = argument(command, "--profile") ?? (command.includes("--debug") ? "debug" : "release");
      const source = join(target, ...(triple ? [triple] : []), profile);
      if (!["bundle", "oxide-app", "oxide-app.exe"].some((name) => existsSync(join(source, name)))) {
        throw new Error(`No final app binary or bundle was found at ${source}. Compiler cache retained.`);
      }
      log(`Final build outputs available at ${source}`);
    },
  };
  log(`Reusable Rust build directory: ${target}`);
  return run(session);
}
