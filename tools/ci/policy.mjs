// Every decision the CI/CD pipeline makes, as pure functions. Workflows and
// the local runner only gather inputs and act on the answers (see cli.mjs).

const LANES = ["web", "rust", "bundle", "supplyChain", "automation"];
const allLanes = (on) => Object.fromEntries(LANES.map((lane) => [lane, on]));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// The shared build workflow, called by CI for bundles and by Release.
const BUILD_WORKFLOW = ".github/workflows/build.yml";

// Each rule names the lanes a path can affect. A path must match at least one
// rule; `[]` marks paths that affect no lane (docs, research, screenshots).
const PATH_RULES = [
  [/^crates\//, ["rust"]],
  [/^(Cargo\.toml|Cargo\.lock|rust-toolchain\.toml|\.cargo\/.*|\.config\/nextest\.toml)$/, ["rust"]],
  [/^\.github\/actions\/setup-rust\//, ["rust"]], // the shared Rust setup: toolchain, cache, libclang
  [/^web\/src\/bindings\.ts$/, ["rust"]], // also web: the Rust tests generate what the web app imports
  [/^web\//, ["web"]],
  [/^\.node-version$/, ["web", "bundle"]],
  // Packaging inputs: only `tauri build` can break these.
  [/^crates\/oxide-app\/(tauri(\.[\w-]+)?\.conf\.json|Info\.plist|capabilities\/.*|icons\/.*)$/, ["bundle"]],
  [/^docs\/licenses\//, ["bundle"]], // bundled as app resources
  [/^(Cargo\.toml|Cargo\.lock|crates\/[^/]+\/Cargo\.toml|web\/package\.json|web\/pnpm-lock\.yaml)$/, ["bundle", "supplyChain"]],
  [/^(crates\/[^/]+\/build\.rs|tools\/build\.mjs|tools\/checks\/.*)$/, ["bundle"]],
  [new RegExp(`^${escapeRegExp(BUILD_WORKFLOW)}$`), ["bundle"]],
  [/^(web\/pnpm-workspace\.yaml|deny\.toml)$/, ["supplyChain"]],
  [/^(\.github|tools)\//, ["automation"]],
  [/^(docs|references|assets|\.agents|\.impeccable)\//, []],
  [/^[^/]+\.md$/, []],
  [/^(LICENSE|\.gitignore|\.gitmodules)$/, []],
];

function lanesForPath(path) {
  const matched = PATH_RULES.filter(([pattern]) => pattern.test(path));
  return matched.length === 0 ? undefined : matched.flatMap(([, on]) => on);
}

// The pull request files API lists at most this many files.
const MAX_LISTED_FILES = 3000;

/**
 * Which CI lanes a change can affect. Fails open: every lane runs unless the
 * event is a pull request with a complete list of paths that every rule knows.
 * `total` is the PR's changed-file count; a shorter list was truncated (a
 * longer one is fine: renames list both paths).
 */
export function lanesFor(changedFiles, event, { total } = {}) {
  if (event !== "pull_request" || !Array.isArray(changedFiles) || changedFiles.length === 0) return allLanes(true);
  if (changedFiles.length >= MAX_LISTED_FILES || total > changedFiles.length) return allLanes(true);
  const result = allLanes(false);
  for (const path of changedFiles) {
    const on = lanesForPath(path);
    if (!on) return allLanes(true);
    for (const lane of on) result[lane] = true;
  }
  return result;
}

// The lane each CI job belongs to. Jobs not listed here must always run.
const JOB_LANES = {
  web: "web", "rust-fmt": "rust", rust: "rust", "supply-chain": "supplyChain", automation: "automation", bundle: "bundle",
};
const PULL_REQUEST_ONLY_JOBS = new Set(["pr-title"]);

function mayBeSkipped(job, lanes, event) {
  if (PULL_REQUEST_ONLY_JOBS.has(job)) return event !== "pull_request";
  // A lane counts as off only when it was explicitly turned off.
  const lane = lanes?.[JOB_LANES[job]];
  return job in JOB_LANES && (lane === false || lane === "false");
}

/**
 * The single required check. `jobResults` maps job ids to a result, or to the
 * workflow's `needs` entries; `lanes` may be booleans or step-output strings.
 * A job passes only if it succeeded, or was skipped because its lane was off or
 * its event doesn't apply.
 */
export function evaluateGate(jobResults, lanes, event) {
  const jobs = Object.entries(jobResults ?? {}).map(([job, value]) => [job, typeof value === "string" ? value : value?.result]);
  if (jobs.length === 0) return { ok: false, message: "No job results reached the gate." };
  const problems = [];
  for (const [job, result] of jobs) {
    if (result === "success") continue;
    if (result === "skipped" && mayBeSkipped(job, lanes, event)) continue;
    if (result === "skipped") problems.push(`${job} was skipped although it had to run`);
    else problems.push(`${job} ${{ failure: "failed", cancelled: "was cancelled" }[result] ?? `ended with ${result ?? "no result"}`}`);
  }
  if (problems.length > 0) return { ok: false, message: `Gate failed: ${problems.join("; ")}.` };
  const skipped = jobs.filter(([, result]) => result === "skipped").map(([job]) => job);
  return { ok: true, message: `Gate passed: ${jobs.length - skipped.length} jobs succeeded${skipped.length ? `, skipped as not affected: ${skipped.join(", ")}` : ""}.` };
}

// The git-workflow branch types, plus the other Conventional Commit types we use.
const TITLE_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "research", "perf", "build", "ci", "revert"];
const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s][^()]*)\))?(?<breaking>!)?: (?<description>\S.*)$/;

function parseTitle(title) {
  const match = String(title ?? "").trim().match(CONVENTIONAL);
  return match && TITLE_TYPES.includes(match.groups.type) ? match.groups : undefined;
}

/** The squash title becomes the main commit and its release-notes line. */
export function checkPrTitle(title) {
  if (parseTitle(title)) return { ok: true, message: `PR title is a valid Conventional Commit: ${title}` };
  return {
    ok: false,
    message: `PR title "${title ?? ""}" is not a Conventional Commit. Use "<type>(<scope>): <description>", where the scope is optional, ` +
      `"!" before the colon marks a breaking change, and <type> is one of: ${TITLE_TYPES.join(", ")}. ` +
      `Example: "fix(terminal): keep input focus after a resize".`,
  };
}

// Windows checkouts may convert line endings; parse both the same way.
const lf = (text) => String(text ?? "").replace(/\r\n/g, "\n");
// A release is X.Y.Z, or X.Y.Z-rc.N for a release candidate.
const VERSION = String.raw`\d+\.\d+\.\d+(?:-rc\.\d+)?`;
const RELEASE_VERSION = new RegExp(`^${VERSION}$`);
const TAG = new RegExp(`^v(${VERSION})$`);
// Groups: everything before the value, the value, the closing quote.
const WORKSPACE_PACKAGE = /^(\[workspace\.package\]\r?\n(?:(?!\[).*\n)*?version\s*=\s*")([^"]*)(")/m;

// The version lives in three places; they and the tag must agree.
const VERSION_FILES = {
  cargoToml: { path: "Cargo.toml", read: (text) => text.match(WORKSPACE_PACKAGE)?.[2] },
  tauriConf: { path: "crates/oxide-app/tauri.conf.json", read: (text) => JSON.parse(text).version },
  webPackage: { path: "web/package.json", read: (text) => JSON.parse(text).version },
};

function declaredVersion(key, text) {
  try { return VERSION_FILES[key].read(text); } catch { return undefined; }
}

/** A release tag must equal the version of the workspace, the Tauri config and the web app. */
export function checkReleaseVersion({ tag, cargoToml, tauriConf, webPackage }) {
  const tagVersion = String(tag ?? "").match(TAG)?.[1];
  if (!tagVersion) return { ok: false, message: `Tag "${tag ?? ""}" is not of the form vX.Y.Z or vX.Y.Z-rc.N.` };
  const files = { cargoToml, tauriConf, webPackage };
  const mismatched = Object.keys(VERSION_FILES)
    .map((key) => [VERSION_FILES[key].path, declaredVersion(key, files[key])])
    .filter(([, version]) => version !== tagVersion);
  if (mismatched.length > 0) {
    const list = mismatched.map(([file, version]) => `${file} ${version ?? "(unreadable)"}`).join(", ");
    return {
      ok: false,
      message: `Tag ${tag} does not match the declared version: ${list}. Run "node tools/ci/cli.mjs bump ${tagVersion}" in a PR into main before tagging.`,
    };
  }
  return { ok: true, message: `Tag ${tag} matches Cargo.toml, tauri.conf.json and web/package.json.` };
}

function setJsonVersion(text, version, file) {
  // Edit the text, not a re-serialised object, so hand formatting survives.
  const updated = text.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (JSON.parse(updated).version !== version) throw new Error(`Cannot find the top-level version in ${file}.`);
  return updated;
}

/**
 * Bump the release version in every place it is declared. `members` are the
 * workspace package names whose `Cargo.lock` entries carry that version.
 */
export function bumpVersion({ cargoToml, tauriConf, webPackage, cargoLock }, version, { members }) {
  const next = String(version).replace(/^v/, "");
  if (!RELEASE_VERSION.test(next)) throw new Error(`"${version}" is not a version of the form X.Y.Z or X.Y.Z-rc.N.`);
  if (!WORKSPACE_PACKAGE.test(cargoToml)) throw new Error("Cannot find the version in [workspace.package] of Cargo.toml.");
  const bumped = {
    cargoToml: cargoToml.replace(WORKSPACE_PACKAGE, `$1${next}$3`),
    tauriConf: setJsonVersion(tauriConf, next, VERSION_FILES.tauriConf.path),
    webPackage: setJsonVersion(webPackage, next, VERSION_FILES.webPackage.path),
    cargoLock,
  };
  for (const name of members) {
    // Workspace packages are the lock entries without a `source` line.
    const entry = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name}"\\r?\\nversion = ")[^"]*("\\r?\\n(?!source = ))`);
    if (!entry.test(bumped.cargoLock)) throw new Error(`Cannot find the workspace package ${name} in Cargo.lock.`);
    bumped.cargoLock = bumped.cargoLock.replace(entry, `$1${next}$2`);
  }
  return bumped;
}

// `tauri build` refuses a `tauri` crate and JS packages on different major.minor.
const TAURI_JS_PACKAGES = ["@tauri-apps/api", "@tauri-apps/cli"];
const majorMinor = (version) => version.split(".").slice(0, 2).join(".");

/** Catch a half-landed Tauri bump in the PR instead of at release. */
export function checkTauriAlignment({ cargoLock, pnpmLock }) {
  const crate = lf(cargoLock).match(/\[\[package\]\]\nname = "tauri"\nversion = "([^"]+)"/)?.[1];
  if (!crate) return { ok: false, message: "The tauri crate was not found in Cargo.lock." };
  const problems = [];
  for (const name of TAURI_JS_PACKAGES) {
    // The resolved version in the `importers` section of a pnpm v9 lockfile.
    const version = lf(pnpmLock).match(new RegExp(`'${escapeRegExp(name)}':\\n\\s+specifier: .*\\n\\s+version: ([^\\s(]+)`))?.[1];
    if (!version) problems.push(`${name} was not found in web/pnpm-lock.yaml`);
    else if (majorMinor(version) !== majorMinor(crate)) problems.push(`${name} ${version}`);
  }
  if (problems.length > 0) {
    return { ok: false, message: `Tauri packages must share the major.minor of the tauri crate ${crate}: ${problems.join(", ")}. Bump the Rust and web halves together.` };
  }
  return { ok: true, message: `Tauri packages aligned on ${majorMinor(crate)} (tauri ${crate}).` };
}

const NOTE_SECTIONS = ["Breaking changes", "Features", "Fixes", "Dependencies", "Documentation", "Other"];

function noteSection(parsed, body) {
  if (parsed?.breaking || /^BREAKING[ -]CHANGE:/m.test(lf(body))) return "Breaking changes";
  if (!parsed) return "Other";
  const { type, scope } = parsed;
  if (["chore", "build"].includes(type) && ["deps", "deps-dev"].includes(scope)) return "Dependencies";
  return { feat: "Features", fix: "Fixes", docs: "Documentation" }[type] ?? "Other";
}

/**
 * The tag release notes start from. `earlierTags` are the `v*` tags before
 * `tag`, newest first. A stable release skips the candidates before it.
 */
export function previousReleaseTag(tag, earlierTags) {
  const stable = !tag.includes("-");
  return earlierTags.find((earlier) => TAG.test(earlier) && (!stable || !earlier.includes("-")));
}

/**
 * Draft release notes from the squash-merged titles since the previous tag.
 * `commits` are `{ subject, body }`, newest or oldest first as given.
 */
export function releaseNotes(commits, { repository, previousTag, tag }) {
  const sections = Object.fromEntries(NOTE_SECTIONS.map((name) => [name, []]));
  for (const { subject, body } of commits) {
    const [, title, pr] = String(subject).trim().match(/^(.*?)(?:\s*\(#(\d+)\))?$/);
    const parsed = parseTitle(title);
    if (parsed?.type === "chore" && parsed.scope === "release") continue;
    const section = noteSection(parsed, body);
    const text = !parsed || section === "Other" ? title : `${parsed.scope ? `**${parsed.scope}:** ` : ""}${parsed.description}`;
    sections[section].push(`- ${text}${pr ? ` ([#${pr}](https://github.com/${repository}/pull/${pr}))` : ""}`);
  }
  const changelog = previousTag
    ? `**Full changelog:** https://github.com/${repository}/compare/${previousTag}...${tag}`
    : `**Full history:** https://github.com/${repository}/commits/${tag}`;
  const filled = NOTE_SECTIONS.filter((name) => sections[name].length > 0);
  if (filled.length === 0) return `No changes${previousTag ? ` since ${previousTag}` : ""}.\n\n${changelog}\n`;
  return `${filled.map((name) => `### ${name}\n\n${sections[name].join("\n")}\n`).join("\n")}\n${changelog}\n`;
}

// Packages that break when moved alone, or whose bumps change generated bindings.
const MANUAL_GROUPS = new Set(["tauri", "specta"]);

function parseVersion(version) {
  const match = String(version ?? "").match(/^v?(\d+)\.(\d+)\.\d+/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

// Why an update needs a human, or undefined when it is low-risk.
function riskOf({ dependencyName: name, updateType, prevVersion, newVersion, dependencyGroup }) {
  if (MANUAL_GROUPS.has(dependencyGroup)) return `${name} is in the ${dependencyGroup} group`;
  const previous = parseVersion(prevVersion);
  if (!previous || !parseVersion(newVersion)) return `${name} has unreadable versions (${prevVersion ?? "?"} → ${newVersion ?? "?"})`;
  switch (updateType) {
    case "version-update:semver-patch":
      return previous.major === 0 && previous.minor === 0 ? `${name} ${prevVersion} is 0.0.x, so a patch may break` : undefined;
    case "version-update:semver-minor":
      return previous.major === 0 ? `${name} ${prevVersion} is 0.x, so a minor may break` : undefined;
    case "version-update:semver-major":
      return `${name} is a major update`;
    default:
      return `${name} has an unknown update type "${updateType ?? ""}"`;
  }
}

/**
 * Whether a Dependabot PR may auto-merge once the gate passes. The input is
 * dependabot/fetch-metadata's `updated-dependencies-json`.
 */
export function dependabotDecision(updatedDependencies) {
  if (!Array.isArray(updatedDependencies) || updatedDependencies.length === 0) {
    return { decision: "manual", reason: "no updated dependencies could be read" };
  }
  const risks = updatedDependencies.map(riskOf).filter(Boolean);
  if (risks.length > 0) return { decision: "manual", reason: risks.join("; ") };
  return { decision: "auto", reason: "every update is a patch, or a minor of a package at 1.0 or later" };
}

// The Tauri updater platform key for each signed updater package.
const UPDATER_PACKAGES = [["darwin-aarch64", /\.app\.tar\.gz$/], ["windows-x86_64", /_x64-setup\.exe$/]];

/**
 * The `latest.json` feed the native updater reads. `signatures` maps each
 * updater package name to the contents of its `.sig` file.
 */
export function updateManifest(artifactNames, signatures, { repository, tag, date }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repository ?? ""))) throw new Error(`Invalid repository "${repository ?? ""}": expected owner/name.`);
  if (!TAG.test(String(tag ?? ""))) throw new Error(`Invalid tag "${tag ?? ""}": expected vX.Y.Z or vX.Y.Z-rc.N.`);
  const platforms = {};
  for (const [platform, pattern] of UPDATER_PACKAGES) {
    const packages = artifactNames.filter((name) => pattern.test(name));
    if (packages.length === 0) continue;
    if (packages.length > 1) throw new Error(`${platform}: expected exactly one updater package, found ${packages.join(", ")}.`);
    const [name] = packages;
    if (!(name in signatures)) throw new Error(`Missing signature for ${name}.`);
    const signature = String(signatures[name]).trim();
    if (!signature) throw new Error(`Empty signature for ${name}.`);
    platforms[platform] = { signature, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}` };
  }
  if (Object.keys(platforms).length === 0) throw new Error("No updater packages found (.app.tar.gz or _x64-setup.exe).");
  const version = tag.slice(1);
  return {
    version,
    notes: `Oxide ${version}\nRelease notes: https://github.com/${repository}/releases/tag/${tag}`,
    pub_date: date,
    platforms,
  };
}

// Node platform names and how the plan names them.
const OS_NAMES = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const EVERY_OS = Object.keys(OS_NAMES);
const RUST_OS = ["darwin", "win32"];
const CI_JOB_ONLY = (job, what) => `CI only: the ${job} job ${what}`;

// What the PR lanes run, in the order the local runner runs it. A check with
// `ci` instead of a command needs a tool or context that only CI has.
const CHECKS = [
  { id: "web-install", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "install", "--frozen-lockfile"] },
  { id: "rust-fmt", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["cargo", "fmt", "--all", "--check"] },
  { id: "web-lint", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "lint"] },
  { id: "web-typecheck", tiers: ["fast", "pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "typecheck"] },
  { id: "web-test", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "test"] },
  { id: "web-build", tiers: ["pr"], platforms: EVERY_OS, command: ["pnpm", "--dir", "web", "build"] },
  { id: "tooling-tests", tiers: ["pr"], platforms: EVERY_OS, command: ["node", "--test", "tools/**/*.test.mjs"] },
  { id: "tauri-alignment", tiers: ["pr"], platforms: EVERY_OS, command: ["node", "tools/ci/cli.mjs", "tauri-alignment"] },
  { id: "clippy", tiers: ["pr"], platforms: RUST_OS, command: ["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"] },
  { id: "rust-test", tiers: ["pr"], platforms: RUST_OS, command: ["cargo", "nextest", "run", "--locked", "--workspace"] },
  // The Rust tests regenerate the bindings; a diff means they were not committed.
  { id: "bindings", tiers: ["pr"], platforms: RUST_OS, command: ["git", "diff", "--exit-code", "web/src/bindings.ts"] },
  { id: "bundle-macos", tiers: ["pr"], platforms: ["darwin"], command: ["web/node_modules/.bin/tauri", "build", "--ci", "--bundles", "app,dmg"] },
  { id: "bundle-windows", tiers: ["pr"], platforms: ["win32"], command: ["web/node_modules/.bin/tauri.cmd", "build", "--ci", "--bundles", "nsis"] },
  { id: "cargo-deny", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("supply-chain", "installs cargo-deny and checks bans, licences and sources") },
  { id: "dependency-review", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("supply-chain", "asks GitHub to review dependencies the PR adds") },
  { id: "actionlint", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs actionlint") },
  { id: "zizmor", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs zizmor") },
  { id: "schemas", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("automation", "installs check-jsonschema") },
  { id: "pr-title", tiers: ["pr"], platforms: EVERY_OS, ci: CI_JOB_ONLY("pr-title", "checks the pull request title") },
];

function skipReason(check, platform) {
  if (check.ci) return check.ci;
  if (check.platforms.includes(platform)) return undefined;
  const where = check.platforms.map((name) => OS_NAMES[name]).join(" and ");
  return `runs only on ${where}${platform === "linux" ? ", the platforms Oxide ships on" : ""}`;
}

/**
 * The commands the PR lanes run on this OS, in order, and what the local
 * runner can't run here and why. `fast` is the pre-commit subset.
 */
export function localPlan(platform, tier = "pr") {
  if (!Object.hasOwn(OS_NAMES, platform)) throw new Error(`Unsupported platform "${platform}".`);
  if (!["fast", "pr"].includes(tier)) throw new Error(`Unknown tier "${tier}": use fast or pr.`);
  const plan = { run: [], skipped: [] };
  for (const check of CHECKS.filter(({ tiers }) => tiers.includes(tier))) {
    const reason = skipReason(check, platform);
    if (reason) plan.skipped.push({ id: check.id, reason });
    else plan.run.push({ id: check.id, command: check.command });
  }
  return plan;
}

/** A command as one line to copy into a shell. Quoting keeps glob patterns for the program to expand. */
export function commandLine(command) {
  return command.map((part) => (/[\s*?]/.test(part) ? `"${part}"` : part)).join(" ");
}
