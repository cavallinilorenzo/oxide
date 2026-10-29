// Thin wrapper over policy.mjs: read files and environment variables, print
// the decision, write step outputs, exit non-zero on a failed check.
//
//   node tools/ci/cli.mjs lanes <changed-files.txt>    env GITHUB_EVENT_NAME, CHANGED_FILES_TOTAL
//   node tools/ci/cli.mjs gate                          env NEEDS_JSON (toJSON(needs)), GITHUB_EVENT_NAME
//   node tools/ci/cli.mjs pr-title                      env PR_TITLE
//   node tools/ci/cli.mjs release-version <tag>
//   node tools/ci/cli.mjs tauri-alignment
//   node tools/ci/cli.mjs release-notes <tag> [<previous-tag>]
//   node tools/ci/cli.mjs dependabot                    env DEPENDENCIES_JSON
//   node tools/ci/cli.mjs update-manifest <dir> <tag> [<owner/repo>]
//   node tools/ci/cli.mjs bump <version>                writes the three manifests and Cargo.lock
//
// Untrusted values (titles, file lists) arrive through files and environment
// variables, never through workflow expressions in a shell script.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpVersion, checkPrTitle, checkReleaseVersion, checkTauriAlignment, dependabotDecision, evaluateGate, lanesFor,
  previousReleaseTag, releaseNotes, updateManifest,
} from "./policy.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(repoRoot, path), "utf8");
const MANIFESTS = {
  cargoToml: "Cargo.toml", tauriConf: "crates/oxide-app/tauri.conf.json", webPackage: "web/package.json", cargoLock: "Cargo.lock",
};

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/\r?\n|\r/g, " ")}\n`).join(""));
}

function report({ ok, message }) {
  if (ok) console.log(message);
  else console.error(process.env.GITHUB_ACTIONS === "true" ? `::error::${message}` : message);
  process.exitCode = ok ? 0 : 1;
}

function git(...args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function earlierTags(tag) {
  try { return git("tag", "--list", "v*", "--merged", `${tag}^`, "--sort=-v:refname").split(/\r?\n/).filter(Boolean); } catch { return []; }
}

function workspaceMembers() {
  const members = read("Cargo.toml").match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1].match(/"[^"]+"/g) ?? [];
  return members.map((member) => read(`${member.slice(1, -1)}/Cargo.toml`).match(/^name\s*=\s*"([^"]+)"/m)[1]);
}

const commands = {
  lanes([listFile]) {
    const files = listFile && existsSync(listFile)
      ? readFileSync(listFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : undefined;
    const total = Number.parseInt(process.env.CHANGED_FILES_TOTAL ?? "", 10);
    const lanes = lanesFor(files, process.env.GITHUB_EVENT_NAME, Number.isNaN(total) ? {} : { total });
    console.log(Object.entries(lanes).map(([lane, on]) => `${lane}: ${on ? "on" : "off"}`).join("\n"));
    output(lanes);
  },
  gate() {
    const needs = JSON.parse(process.env.NEEDS_JSON || "{}");
    report(evaluateGate(needs, needs.changes?.outputs, process.env.GITHUB_EVENT_NAME));
  },
  "pr-title"() {
    report(checkPrTitle(process.env.PR_TITLE));
  },
  "release-version"([tag]) {
    report(checkReleaseVersion({ tag, cargoToml: read(MANIFESTS.cargoToml), tauriConf: read(MANIFESTS.tauriConf), webPackage: read(MANIFESTS.webPackage) }));
  },
  "tauri-alignment"() {
    report(checkTauriAlignment({ cargoLock: read(MANIFESTS.cargoLock), pnpmLock: read("web/pnpm-lock.yaml") }));
  },
  "release-notes"([tag, previous = previousReleaseTag(tag, earlierTags(tag))]) {
    const range = previous ? `${previous}..${tag}` : tag;
    const commits = git("log", "--format=%s%x1f%b%x1e", range).split("\x1e").map((entry) => entry.trim()).filter(Boolean)
      .map((entry) => { const [subject, body = ""] = entry.split("\x1f"); return { subject, body }; });
    const repository = process.env.GITHUB_REPOSITORY ?? "cavallinilorenzo/oxide";
    process.stdout.write(releaseNotes(commits, { repository, previousTag: previous, tag }));
  },
  dependabot() {
    let dependencies;
    try { dependencies = JSON.parse(process.env.DEPENDENCIES_JSON || "[]"); } catch { dependencies = undefined; }
    const { decision, reason } = dependabotDecision(dependencies);
    console.log(`${decision}: ${reason}`);
    output({ decision, reason });
  },
  "update-manifest"([directory = "release-artifacts", tag, repository = "cavallinilorenzo/oxide"]) {
    const names = readdirSync(directory);
    const signatures = Object.fromEntries(names.filter((name) => name.endsWith(".sig"))
      .map((name) => [name.slice(0, -".sig".length), readFileSync(join(directory, name), "utf8")]));
    const feed = updateManifest(names, signatures, { repository, tag, date: new Date().toISOString() });
    writeFileSync(join(directory, "latest.json"), `${JSON.stringify(feed, null, 2)}\n`);
    console.log(`Wrote ${join(directory, "latest.json")} for ${Object.keys(feed.platforms).join(", ")}.`);
  },
  bump([version]) {
    const current = Object.fromEntries(Object.entries(MANIFESTS).map(([key, path]) => [key, read(path)]));
    const bumped = bumpVersion(current, version ?? "", { members: workspaceMembers() });
    for (const [key, path] of Object.entries(MANIFESTS)) {
      if (bumped[key] !== current[key]) writeFileSync(join(repoRoot, path), bumped[key]);
    }
    const next = version.replace(/^v/, "");
    console.log(`Version ${next} written to ${Object.values(MANIFESTS).join(", ")}.`);
    console.log(`Open a PR titled "chore(release): v${next}"; once its main run passes the gate, tag that commit v${next}.`);
  },
};

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
  console.error(`Usage: node tools/ci/cli.mjs <${Object.keys(commands).join("|")}> [arguments]`);
  process.exitCode = 2;
} else {
  try {
    commands[name](args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
