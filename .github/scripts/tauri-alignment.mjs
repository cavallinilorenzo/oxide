// Fails when the `tauri` crate and the `@tauri-apps/*` JS packages drift apart.
// `tauri build` refuses mismatched major.minor versions; this catches a
// half-applied Tauri bump in CI instead of at bundle time.
//
// Usage (from the repo root): node .github/scripts/tauri-alignment.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const JS_PACKAGES = ["@tauri-apps/api", "@tauri-apps/cli"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function crateVersion(cargoLock, name) {
  const pattern = new RegExp(`\\[\\[package\\]\\]\\nname = "${escapeRegExp(name)}"\\nversion = "([^"]+)"`);
  return cargoLock.match(pattern)?.[1];
}

// Reads the resolved version from the `importers` section of a pnpm v9 lockfile.
function pnpmVersion(pnpmLock, name) {
  const pattern = new RegExp(`'${escapeRegExp(name)}':\\n\\s+specifier: .*\\n\\s+version: ([^\\s(]+)`);
  return pnpmLock.match(pattern)?.[1];
}

const majorMinor = (version) => version.split(".").slice(0, 2).join(".");

export function checkTauriAlignment({ cargoLock, pnpmLock }) {
  const crate = crateVersion(cargoLock, "tauri");
  if (!crate) return { ok: false, message: "tauri crate not found in Cargo.lock" };

  const problems = [];
  for (const name of JS_PACKAGES) {
    const version = pnpmVersion(pnpmLock, name);
    if (!version) problems.push(`${name} not found in web/pnpm-lock.yaml`);
    else if (majorMinor(version) !== majorMinor(crate)) problems.push(`${name} ${version}`);
  }

  if (problems.length > 0) {
    return {
      ok: false,
      message: `Tauri packages are misaligned with the tauri crate ${crate} (major.minor must match): ${problems.join(", ")}`,
    };
  }
  return { ok: true, message: `Tauri packages aligned on ${majorMinor(crate)} (tauri ${crate})` };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkTauriAlignment({
    cargoLock: readFileSync("Cargo.lock", "utf8"),
    pnpmLock: readFileSync("web/pnpm-lock.yaml", "utf8"),
  });
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
