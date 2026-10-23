// Release version gate: a `vX.Y.Z` tag must equal the version declared in the
// workspace Cargo.toml, the Tauri config and the web package manifest.
//
// Usage (from the repo root): node .github/scripts/release-version.mjs v0.2.0
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function workspaceVersion(cargoToml) {
  const section = cargoToml.split(/^\[workspace\.package\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  return section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

export function checkReleaseVersion({ tag, cargoToml, tauriConf, webPackage }) {
  const tagVersion = tag.match(TAG)?.[1];
  if (!tagVersion) return { ok: false, message: `Tag "${tag}" is not of the form vX.Y.Z` };

  const declared = [
    ["Cargo.toml", workspaceVersion(cargoToml)],
    ["crates/oxide-app/tauri.conf.json", JSON.parse(tauriConf).version],
    ["web/package.json", JSON.parse(webPackage).version],
  ];
  const mismatched = declared.filter(([, version]) => version !== tagVersion);

  if (mismatched.length > 0) {
    const list = mismatched.map(([file, version]) => `${file} ${version ?? "(missing)"}`).join(", ");
    return {
      ok: false,
      message: `Tag ${tag} does not match the declared version: ${list}. Bump all three in a PR into main before tagging.`,
    };
  }
  return { ok: true, message: `Tag ${tag} matches Cargo.toml, tauri.conf.json and web/package.json` };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkReleaseVersion({
    tag: process.argv[2] ?? "",
    cargoToml: readFileSync("Cargo.toml", "utf8"),
    tauriConf: readFileSync("crates/oxide-app/tauri.conf.json", "utf8"),
    webPackage: readFileSync("web/package.json", "utf8"),
  });
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
