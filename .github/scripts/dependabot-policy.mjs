// Decides whether a Dependabot PR may auto-merge or needs manual review.
// Input is dependabot/fetch-metadata's `updated-dependencies-json`.
//
// Auto-merge: semver-patch updates, and semver-minor updates of packages >= 1.0.
// Manual review: majors, 0.x minors (and 0.0.x patches), anything in the
// `tauri` or `specta` groups, and anything whose versions can't be read.
//
// Usage: DEPENDENCIES_JSON='[...]' node .github/scripts/dependabot-policy.mjs
// Writes `decision=auto|manual` and `reason=...` to $GITHUB_OUTPUT when set.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MANUAL_GROUPS = new Set(["tauri", "specta"]);

function parseVersion(version) {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

// Returns why this update needs a human, or undefined when it is low-risk.
function riskOf({ dependencyName: name, updateType, prevVersion, dependencyGroup }) {
  if (MANUAL_GROUPS.has(dependencyGroup)) return `${name} is in the ${dependencyGroup} group`;

  const previous = parseVersion(prevVersion);
  switch (updateType) {
    case "version-update:semver-patch":
      if (previous?.major === 0 && previous.minor === 0) return `${name} ${prevVersion} is 0.0.x, so a patch is breaking`;
      return undefined;
    case "version-update:semver-minor":
      if (!previous) return `${name} has no readable previous version`;
      if (previous.major === 0) return `${name} ${prevVersion} is 0.x, so a minor is breaking`;
      return undefined;
    case "version-update:semver-major":
      return `${name} is a major update`;
    default:
      return `${name} has an unknown update type "${updateType ?? ""}"`;
  }
}

export function decideMerge(dependencies) {
  if (dependencies.length === 0) return { decision: "manual", reason: "no updated dependencies could be parsed" };

  const risks = dependencies.map(riskOf).filter(Boolean);
  if (risks.length > 0) return { decision: "manual", reason: risks.join("; ") };
  return { decision: "auto", reason: "all updates are patch, or minor on >= 1.0" };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { decision, reason } = decideMerge(JSON.parse(process.env.DEPENDENCIES_JSON || "[]"));
  console.log(`${decision}: ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\nreason=${reason.replace(/\n/g, " ")}\n`);
  }
}
