// Local app build: reuse Cargo's cache and leave final outputs in place.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBuildSpace } from "./checks/build-space.mjs";
import { withBuildSession } from "./checks/build-session.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const command = ["web/node_modules/.bin/tauri", "build", ...process.argv.slice(2)];
try {
  assertBuildSpace(repoRoot);
  process.exitCode = withBuildSession(repoRoot, process.env, (session) => {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: repoRoot, stdio: "inherit", env: session.env, shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status === 0) session.reportOutputs(command);
    assertBuildSpace(repoRoot);
    return result.status ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
