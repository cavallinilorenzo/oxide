import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bumpVersion, checkDictationPackage, checkPrTitle, checkUpdateFeed, checkWorkerProbe, checkReleaseVersion, checkTauriAlignment, commandLine, dependabotDecision, evaluateGate, lanesFor,
  checkAppLaunch, dictationBuildCache, GPU_BUILD_SDKS, localPlan, previousReleaseTag, releaseNotes, runtimeManifestProblems, updateManifest,
} from "./policy.mjs";

const ALL_ON = { web: true, rust: true, bundle: true, supplyChain: true, automation: true };
const ALL_OFF = { web: false, rust: false, bundle: false, supplyChain: false, automation: false };

describe("dictationBuildCache", () => {
  const inputs = { platform: "windows-x64", release: false, fingerprint: "native-inputs", imageVersion: "20261021.278.1" };

  test("Windows CI can reuse its native worker builds", () => {
    assert.equal(dictationBuildCache(inputs).enabled, true);
    assert.ok(dictationBuildCache(inputs).key.includes(inputs.fingerprint));
  });

  test("release builds and macOS never use this cache", () => {
    for (const platform of ["windows-x64", "macos-aarch64"]) {
      assert.deepEqual(dictationBuildCache({ platform, release: true }), { enabled: false, key: "" });
    }
    assert.deepEqual(dictationBuildCache({ platform: "macos-aarch64", release: false }), { enabled: false, key: "" });
    assert.deepEqual(dictationBuildCache({ platform: "windows-x64" }), { enabled: false, key: "" });
  });

  test("a compiler image or native input change invalidates the cache", () => {
    const key = dictationBuildCache(inputs).key;
    assert.notEqual(dictationBuildCache({ ...inputs, fingerprint: "changed-lockfile-or-flags" }).key, key);
    assert.notEqual(dictationBuildCache({ ...inputs, imageVersion: "20261028.1" }).key, key);
    assert.throws(() => dictationBuildCache({ ...inputs, fingerprint: "" }), /fingerprint/);
    assert.throws(() => dictationBuildCache({ ...inputs, imageVersion: "" }), /image/);
  });
});

describe("lanesFor", () => {
  test("a docs-only change turns every lane off", () => {
    assert.deepEqual(lanesFor(["docs/workbench.md", "README.md", "docs/ui-review/main.png", "GLOSSARY.md"], "pull_request"), ALL_OFF);
  });

  test("a web-only change turns on web only", () => {
    assert.deepEqual(lanesFor(["web/src/App.tsx", "web/src/App.test.tsx"], "pull_request"), { ...ALL_OFF, web: true });
  });

  test("a Tauri config change turns on bundle and rust", () => {
    assert.deepEqual(lanesFor(["crates/oxide-app/tauri.conf.json"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true });
  });

  test("a bundled licence file under docs turns on bundle", () => {
    assert.deepEqual(lanesFor(["docs/licenses/whisper.txt"], "pull_request"), { ...ALL_OFF, bundle: true });
  });

  test("a lockfile change turns on supplyChain and bundle", () => {
    assert.deepEqual(lanesFor(["Cargo.lock"], "pull_request"), { ...ALL_OFF, rust: true, supplyChain: true, bundle: true });
    assert.deepEqual(lanesFor(["web/pnpm-lock.yaml"], "pull_request"), { ...ALL_OFF, web: true, supplyChain: true, bundle: true });
  });

  test("a change to the shared Rust setup turns on rust and automation", () => {
    assert.deepEqual(lanesFor([".github/actions/setup-rust/action.yml"], "pull_request"), { ...ALL_OFF, rust: true, automation: true });
  });

  test("a workflow change turns on automation, and bundle if it is the build workflow", () => {
    assert.deepEqual(lanesFor([".github/workflows/ci.yml"], "pull_request"), { ...ALL_OFF, automation: true });
    assert.deepEqual(lanesFor([".github/workflows/build.yml"], "pull_request"), { ...ALL_OFF, automation: true, bundle: true });
  });

  test("a GPU worker or a dictation packaging script turns on bundle: only packaging builds them", () => {
    assert.deepEqual(lanesFor(["crates/oxide-cuda-worker/src/main.rs"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true });
    // Their lockfiles are shipped dependencies too, so the licence policy covers them.
    assert.deepEqual(lanesFor(["crates/oxide-vulkan-worker/Cargo.lock"], "pull_request"), { ...ALL_OFF, rust: true, bundle: true, supplyChain: true });
    assert.deepEqual(lanesFor(["tools/dictation-package.mjs"], "pull_request"), { ...ALL_OFF, automation: true, bundle: true });
    assert.deepEqual(lanesFor(["tools/dictation-build.mjs"], "pull_request"), { ...ALL_OFF, automation: true, bundle: true });
  });

  test("an unknown top-level path turns every lane on", () => {
    assert.deepEqual(lanesFor(["docs/workbench.md", "Makefile"], "pull_request"), ALL_ON);
  });

  test("an empty, missing or truncated list turns every lane on", () => {
    assert.deepEqual(lanesFor([], "pull_request"), ALL_ON);
    assert.deepEqual(lanesFor(undefined, "pull_request"), ALL_ON);
    assert.deepEqual(lanesFor(["docs/a.md"], "pull_request", { total: 4000 }), ALL_ON);
  });

  test("push, schedule and dispatch events turn every lane on", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      assert.deepEqual(lanesFor(["docs/workbench.md"], event), ALL_ON);
    }
  });
});

describe("evaluateGate", () => {
  const passing = {
    changes: "success", web: "success", "rust-fmt": "success", rust: "success", "supply-chain": "success",
    automation: "success", "pr-title": "success", bundle: "success",
  };

  test("all jobs succeeding passes", () => {
    assert.equal(evaluateGate(passing, ALL_ON, "pull_request").ok, true);
  });

  test("a failed or cancelled job fails, naming the job", () => {
    const failed = evaluateGate({ ...passing, rust: "failure" }, ALL_ON, "pull_request");
    assert.equal(failed.ok, false);
    assert.match(failed.message, /rust/);
    const cancelled = evaluateGate({ ...passing, bundle: "cancelled" }, ALL_ON, "pull_request");
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.message, /bundle.*cancelled/);
  });

  test("a job skipped because its lane was off passes", () => {
    const docsOnly = { ...passing, web: "skipped", "rust-fmt": "skipped", rust: "skipped", "supply-chain": "skipped", automation: "skipped", bundle: "skipped" };
    assert.equal(evaluateGate(docsOnly, ALL_OFF, "pull_request").ok, true);
  });

  test("a job skipped although its lane was on fails", () => {
    const result = evaluateGate({ ...passing, rust: "skipped" }, { ...ALL_OFF, rust: true }, "pull_request");
    assert.equal(result.ok, false);
    assert.match(result.message, /rust/);
  });

  test("pr-title skipped on push passes, but not on a pull request", () => {
    assert.equal(evaluateGate({ ...passing, "pr-title": "skipped" }, ALL_ON, "push").ok, true);
    assert.equal(evaluateGate({ ...passing, "pr-title": "skipped" }, ALL_ON, "pull_request").ok, false);
  });

  test("a skipped job that no lane accounts for fails", () => {
    assert.equal(evaluateGate({ ...passing, changes: "skipped" }, ALL_OFF, "pull_request").ok, false);
    assert.equal(evaluateGate({ ...passing, "new-job": "skipped" }, ALL_OFF, "pull_request").ok, false);
  });

  test("reads lanes written as step outputs, where only \"false\" turns a lane off", () => {
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, { rust: "false" }, "pull_request").ok, true);
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, { rust: "true" }, "pull_request").ok, false);
    assert.equal(evaluateGate({ ...passing, rust: "skipped" }, {}, "pull_request").ok, false);
  });

  test("accepts the shape of the workflow's needs context", () => {
    const needs = Object.fromEntries(Object.entries(passing).map(([job, result]) => [job, { result, outputs: {} }]));
    assert.equal(evaluateGate(needs, ALL_ON, "pull_request").ok, true);
    assert.equal(evaluateGate({ ...needs, web: { result: "failure" } }, ALL_ON, "pull_request").ok, false);
  });

  test("no results fails", () => {
    assert.equal(evaluateGate({}, ALL_ON, "pull_request").ok, false);
    assert.equal(evaluateGate(undefined, ALL_ON, "pull_request").ok, false);
  });
});

describe("checkPrTitle", () => {
  test("allowed types pass with and without scope, and with the breaking marker", () => {
    for (const title of [
      "feat(chat): render Markdown in agent messages",
      "fix: terminal input on Windows",
      "research: compare Provider CLIs",
      "chore(deps): bump serde from 1.0.1 to 1.0.2",
      "refactor(core)!: rename the Turn API",
      "feat!: drop the legacy settings file",
      "ci: add the gate check",
    ]) {
      assert.equal(checkPrTitle(title).ok, true, title);
    }
  });

  test("non-conventional titles fail, listing the allowed types", () => {
    for (const title of [".github modified", "fix windows agy", "feature(chat): unknown type", "fix(core) missing colon", "fix(): empty scope", "fix: ", "Feat: capitalised type"]) {
      const result = checkPrTitle(title);
      assert.equal(result.ok, false, title);
      assert.match(result.message, /feat, fix, docs, chore, refactor, test, research, perf, build, ci, revert/);
    }
  });
});

const manifests = (cargo, tauri, web) => ({
  cargoToml: `[workspace]\nmembers = ["crates/oxide-core"]\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2024"\n\n[profile.dev]\ndebug = "line-tables-only"\n`,
  tauriConf: `{\n  "productName": "Oxide",\n  "version": "${tauri}",\n  "identifier": "dev.oxide.app"\n}\n`,
  webPackage: `{\n  "name": "oxide-web",\n  "version": "${web}",\n  "dependencies": { "react": "^19.3.1" }\n}\n`,
});

describe("checkReleaseVersion", () => {
  test("a tag matching all three manifests passes", () => {
    assert.equal(checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.2.0", "0.2.0") }).ok, true);
  });

  test("each mismatch names the file and its version", () => {
    const result = checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.1.0", "0.1.9") });
    assert.equal(result.ok, false);
    assert.match(result.message, /tauri\.conf\.json 0\.1\.0/);
    assert.match(result.message, /web\/package\.json 0\.1\.9/);
    assert.doesNotMatch(result.message, /Cargo\.toml/);
    assert.match(checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.1.5", "0.2.0", "0.2.0") }).message, /Cargo\.toml 0\.1\.5/);
  });

  test("a malformed tag fails", () => {
    for (const tag of ["0.2.0", "v0.2", "release-0.2.0", "v0.2.0 ", "v0.2.0-beta", "v0.2.0-rc"]) {
      const result = checkReleaseVersion({ tag, ...manifests("0.2.0", "0.2.0", "0.2.0") });
      assert.equal(result.ok, false, tag);
      assert.match(result.message, /vX\.Y\.Z/);
    }
  });

  test("a release-candidate suffix is accepted", () => {
    assert.equal(checkReleaseVersion({ tag: "v0.2.0-rc.1", ...manifests("0.2.0-rc.1", "0.2.0-rc.1", "0.2.0-rc.1") }).ok, true);
  });

  test("an unreadable manifest fails instead of throwing", () => {
    const result = checkReleaseVersion({ tag: "v0.2.0", ...manifests("0.2.0", "0.2.0", "0.2.0"), tauriConf: "{ not json" });
    assert.equal(result.ok, false);
    assert.match(result.message, /tauri\.conf\.json/);
  });
});

describe("bumpVersion", () => {
  const cargoLock = [
    "version = 4", "",
    "[[package]]", 'name = "oxide-core"', 'version = "0.1.0"', "dependencies = [", ' "serde",', "]", "",
    "[[package]]", 'name = "serde"', 'version = "0.1.0"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', "",
  ].join("\n");

  test("writes the version to all three manifests and the workspace entries of Cargo.lock", () => {
    const bumped = bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "0.2.0", { members: ["oxide-core"] });
    assert.equal(checkReleaseVersion({ tag: "v0.2.0", ...bumped }).ok, true);
    assert.match(bumped.cargoLock, /name = "oxide-core"\nversion = "0\.2\.0"/);
    assert.match(bumped.cargoLock, /name = "serde"\nversion = "0\.1\.0"/);
    assert.match(bumped.cargoToml, /\[profile\.dev\]\ndebug = "line-tables-only"/);
    assert.match(bumped.webPackage, /"react": "\^19\.3\.1"/);
  });

  test("accepts a leading v and a release-candidate suffix", () => {
    const bumped = bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "v0.2.0-rc.1", { members: ["oxide-core"] });
    assert.equal(checkReleaseVersion({ tag: "v0.2.0-rc.1", ...bumped }).ok, true);
  });

  test("refuses a version that is not X.Y.Z or a release candidate", () => {
    for (const version of ["0.2", "0.2.0-beta"]) {
      assert.throws(() => bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, version, { members: ["oxide-core"] }), /X\.Y\.Z/);
    }
  });

  test("refuses a workspace member missing from Cargo.lock", () => {
    assert.throws(() => bumpVersion({ ...manifests("0.1.0", "0.1.0", "0.1.0"), cargoLock }, "0.2.0", { members: ["oxide-app"] }), /oxide-app/);
  });
});

describe("checkTauriAlignment", () => {
  const cargoLock = (tauri) => `[[package]]\nname = "tauri"\nversion = "${tauri}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "tauri-build"\nversion = "9.9.9"\n`;
  const pnpmLock = (api, cli) => [
    "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:",
    ...(api ? ["      '@tauri-apps/api':", `        specifier: ^${api}`, `        version: ${api}`] : []),
    "    devDependencies:",
    ...(cli ? ["      '@tauri-apps/cli':", `        specifier: ^${cli}`, `        version: ${cli}`] : []),
    "",
  ].join("\n");

  test("the same major.minor passes", () => {
    assert.equal(checkTauriAlignment({ cargoLock: cargoLock("2.12.5"), pnpmLock: pnpmLock("2.12.4", "2.12.0") }).ok, true);
  });

  test("Windows line endings are read the same way", () => {
    const crlf = (text) => text.replace(/\n/g, "\r\n");
    assert.equal(checkTauriAlignment({ cargoLock: crlf(cargoLock("2.12.5")), pnpmLock: crlf(pnpmLock("2.12.4", "2.12.0")) }).ok, true);
  });

  test("drift names the package and both versions", () => {
    const result = checkTauriAlignment({ cargoLock: cargoLock("2.13.0"), pnpmLock: pnpmLock("2.12.4", "2.13.1") });
    assert.equal(result.ok, false);
    assert.match(result.message, /@tauri-apps\/api 2\.12\.4/);
    assert.match(result.message, /2\.13\.0/);
    assert.doesNotMatch(result.message, /@tauri-apps\/cli/);
  });

  test("a missing package fails", () => {
    const noCli = checkTauriAlignment({ cargoLock: cargoLock("2.12.5"), pnpmLock: pnpmLock("2.12.4") });
    assert.equal(noCli.ok, false);
    assert.match(noCli.message, /@tauri-apps\/cli/);
    const noCrate = checkTauriAlignment({ cargoLock: "", pnpmLock: pnpmLock("2.12.4", "2.12.4") });
    assert.equal(noCrate.ok, false);
    assert.match(noCrate.message, /tauri crate/);
  });
});

describe("releaseNotes", () => {
  const identity = { repository: "cavallinilorenzo/oxide", previousTag: "v0.1.0", tag: "v0.2.0" };
  // The lines under one `### <heading>` of the notes.
  const section = (notes, heading) =>
    notes.split(`### ${heading}\n`)[1]?.split("\n###")[0].split("\n").filter((line) => line.startsWith("- ")) ?? [];

  test("types map to sections, and breaking changes and dependency bumps get their own", () => {
    const notes = releaseNotes([
      { subject: "feat(chat): render Markdown in agent messages (#215)" },
      { subject: "fix(workbench): terminal input (#218)" },
      { subject: "docs: explain dictation (#230)" },
      { subject: "chore(deps): bump serde from 1.0.1 to 1.0.2 (#231)" },
      { subject: "chore(deps-dev): bump vitest (#232)" },
      { subject: "refactor(core)!: rename the Turn API (#233)" },
      { subject: "feat(settings): new storage (#234)", body: "BREAKING CHANGE: old settings are not migrated." },
    ], identity);
    assert.deepEqual(section(notes, "Breaking changes"), [
      "- **core:** rename the Turn API ([#233](https://github.com/cavallinilorenzo/oxide/pull/233))",
      "- **settings:** new storage ([#234](https://github.com/cavallinilorenzo/oxide/pull/234))",
    ]);
    assert.deepEqual(section(notes, "Features"), ["- **chat:** render Markdown in agent messages ([#215](https://github.com/cavallinilorenzo/oxide/pull/215))"]);
    assert.deepEqual(section(notes, "Fixes"), ["- **workbench:** terminal input ([#218](https://github.com/cavallinilorenzo/oxide/pull/218))"]);
    assert.deepEqual(section(notes, "Documentation"), ["- explain dictation ([#230](https://github.com/cavallinilorenzo/oxide/pull/230))"]);
    assert.equal(section(notes, "Dependencies").length, 2);
    assert.ok(notes.indexOf("### Breaking changes") < notes.indexOf("### Features"));
    assert.match(notes, /compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  });

  test("release bumps are omitted and other titles go to Other, with PR links", () => {
    const notes = releaseNotes([
      { subject: "chore(release): v0.2.0 (#240)" },
      { subject: ".github modified (#223)" },
      { subject: "ci: add the gate check (#237)" },
    ], identity);
    assert.doesNotMatch(notes, /chore\(release\)|v0\.2\.0 \(/);
    assert.deepEqual(section(notes, "Other"), [
      "- .github modified ([#223](https://github.com/cavallinilorenzo/oxide/pull/223))",
      "- ci: add the gate check ([#237](https://github.com/cavallinilorenzo/oxide/pull/237))",
    ]);
    assert.equal(section(notes, "Features").length, 0);
  });

  test("an empty range says so explicitly", () => {
    for (const commits of [[], [{ subject: "chore(release): v0.2.0 (#240)" }]]) {
      assert.match(releaseNotes(commits, identity), /No changes since v0\.1\.0\./);
    }
    assert.match(releaseNotes([], { ...identity, previousTag: undefined }), /No changes\./);
  });

  test("a stable release is compared with the previous stable tag, a candidate with any earlier tag", () => {
    const earlier = ["v0.2.0-rc.2", "v0.2.0-rc.1", "v0.1.1", "v0.1.0"];
    assert.equal(previousReleaseTag("v0.2.0", earlier), "v0.1.1");
    assert.equal(previousReleaseTag("v0.2.0-rc.3", earlier), "v0.2.0-rc.2");
    assert.equal(previousReleaseTag("v0.1.0", []), undefined);
  });

  test("the first release links to the tag's history instead of a comparison", () => {
    assert.match(releaseNotes([{ subject: "feat: first" }], { ...identity, previousTag: undefined }), /commits\/v0\.2\.0/);
  });
});

describe("dependabotDecision", () => {
  const update = (updateType, prevVersion, newVersion, extra = {}) =>
    ({ dependencyName: "serde", updateType: `version-update:semver-${updateType}`, prevVersion, newVersion, ...extra });

  test("a patch merges automatically, but a 0.0.x patch needs review", () => {
    assert.equal(dependabotDecision([update("patch", "1.0.1", "1.0.2")]).decision, "auto");
    assert.equal(dependabotDecision([update("patch", "0.4.1", "0.4.2")]).decision, "auto");
    const result = dependabotDecision([update("patch", "0.0.3", "0.0.4")]);
    assert.equal(result.decision, "manual");
    assert.match(result.reason, /serde 0\.0\.3/);
  });

  test("a 1.x minor merges automatically, a 0.x minor needs review", () => {
    assert.equal(dependabotDecision([update("minor", "1.2.0", "1.3.0")]).decision, "auto");
    assert.equal(dependabotDecision([update("minor", "v0.11.0", "v0.12.0")]).decision, "manual");
  });

  test("majors and the tauri and specta groups need review", () => {
    assert.equal(dependabotDecision([update("major", "1.0.0", "2.0.0")]).decision, "manual");
    for (const dependencyGroup of ["tauri", "specta"]) {
      const result = dependabotDecision([update("patch", "2.12.4", "2.12.5", { dependencyGroup })]);
      assert.equal(result.decision, "manual");
      assert.match(result.reason, new RegExp(dependencyGroup));
    }
  });

  test("a mixed group with any manual member needs review", () => {
    const result = dependabotDecision([update("patch", "1.0.1", "1.0.2"), update("major", "4.0.0", "5.0.0", { dependencyName: "vite" })]);
    assert.equal(result.decision, "manual");
    assert.match(result.reason, /vite/);
  });

  test("an unknown update type or unreadable versions need review", () => {
    assert.equal(dependabotDecision([{ dependencyName: "serde", updateType: "", prevVersion: "1.0.0", newVersion: "1.0.1" }]).decision, "manual");
    assert.equal(dependabotDecision([update("patch", "abc1234", "def5678")]).decision, "manual");
    assert.equal(dependabotDecision([update("minor", undefined, "1.3.0")]).decision, "manual");
  });

  test("an empty or unreadable list needs review", () => {
    assert.equal(dependabotDecision([]).decision, "manual");
    assert.equal(dependabotDecision(undefined).decision, "manual");
  });
});

describe("checkUpdateFeed", () => {
  const feed = (overrides = {}) => ({
    version: "1.2.3",
    platforms: { "darwin-aarch64": { signature: "sig", url: "https://example.test/a" }, "windows-x86_64": { signature: "sig", url: "https://example.test/b" } },
    ...overrides,
  });

  test("a feed for the published version with signed platforms passes and lists the URLs to resolve", () => {
    const result = checkUpdateFeed(feed(), "v1.2.3");
    assert.equal(result.ok, true);
    assert.deepEqual(result.urls, ["https://example.test/a", "https://example.test/b"]);
  });

  test("a feed that still serves another version fails", () => {
    const result = checkUpdateFeed(feed({ version: "1.2.2" }), "v1.2.3");
    assert.equal(result.ok, false);
    assert.match(result.message, /1\.2\.2.*1\.2\.3/);
  });

  test("an empty signature or a missing URL fails and names the platform", () => {
    const empty = checkUpdateFeed(feed({ platforms: { "darwin-aarch64": { signature: " ", url: "https://example.test/a" } } }), "v1.2.3");
    assert.match(empty.message, /signature for darwin-aarch64/);
    const noUrl = checkUpdateFeed(feed({ platforms: { "windows-x86_64": { signature: "sig" } } }), "v1.2.3");
    assert.match(noUrl.message, /URL for windows-x86_64/);
  });

  test("a feed without platforms or that is not an object fails", () => {
    assert.equal(checkUpdateFeed(feed({ platforms: {} }), "v1.2.3").ok, false);
    assert.equal(checkUpdateFeed(undefined, "v1.2.3").ok, false);
  });
});

describe("updateManifest", () => {
  const release = { repository: "cavallinilorenzo/oxide", tag: "v1.2.3", date: "2026-10-29T00:00:00Z" };
  const artifacts = ["Oxide_1.2.3_aarch64.dmg", "Oxide_1.2.3_aarch64.app.tar.gz", "Oxide_1.2.3_aarch64.app.tar.gz.sig", "Oxide_1.2.3_x64-setup.exe", "Oxide_1.2.3_x64-setup.exe.sig", "SHA256SUMS.txt"];
  const signatures = { "Oxide_1.2.3_aarch64.app.tar.gz": "mac-signature\n", "Oxide_1.2.3_x64-setup.exe": "windows-signature" };

  test("one signed package per platform produces the updater feed", () => {
    assert.deepEqual(updateManifest(artifacts, signatures, release), {
      version: "1.2.3",
      notes: "Oxide 1.2.3\nRelease notes: https://github.com/cavallinilorenzo/oxide/releases/tag/v1.2.3",
      pub_date: "2026-10-29T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "mac-signature",
          url: "https://github.com/cavallinilorenzo/oxide/releases/download/v1.2.3/Oxide_1.2.3_aarch64.app.tar.gz",
        },
        "windows-x86_64": {
          signature: "windows-signature",
          url: "https://github.com/cavallinilorenzo/oxide/releases/download/v1.2.3/Oxide_1.2.3_x64-setup.exe",
        },
      },
    });
  });

  test("a missing or empty signature fails", () => {
    assert.throws(() => updateManifest(artifacts, { "Oxide_1.2.3_x64-setup.exe": "windows-signature" }, release), /Missing signature for Oxide_1\.2\.3_aarch64\.app\.tar\.gz/);
    assert.throws(() => updateManifest(artifacts, { ...signatures, "Oxide_1.2.3_x64-setup.exe": " \n" }, release), /Empty signature for Oxide_1\.2\.3_x64-setup\.exe/);
  });

  test("a duplicate package or no package fails", () => {
    assert.throws(() => updateManifest([...artifacts, "Oxide_1.2.2_x64-setup.exe"], signatures, release), /windows-x86_64: expected exactly one/);
    assert.throws(() => updateManifest(["Oxide_1.2.3_aarch64.dmg", "SHA256SUMS.txt"], {}, release), /No updater packages/);
  });

  test("an invalid tag or repository fails", () => {
    assert.throws(() => updateManifest(artifacts, signatures, { ...release, tag: "1.2.3" }), /tag/);
    assert.throws(() => updateManifest(artifacts, signatures, { ...release, repository: "oxide" }), /repository/);
  });

  test("a release-candidate tag is accepted", () => {
    assert.equal(updateManifest(artifacts, signatures, { ...release, tag: "v1.2.3-rc.1" }).version, "1.2.3-rc.1");
  });

  test("a release can ship one platform", () => {
    const macOnly = updateManifest(["Oxide_1.2.3_aarch64.app.tar.gz"], { "Oxide_1.2.3_aarch64.app.tar.gz": "mac-signature" }, release);
    assert.deepEqual(Object.keys(macOnly.platforms), ["darwin-aarch64"]);
  });
});

describe("localPlan", () => {
  const lines = (plan) => plan.run.map(({ command }) => commandLine(command));
  const CLIPPY = "cargo clippy --locked --workspace --all-targets -- -D warnings";
  const NEXTEST = "cargo nextest run --locked --workspace";

  test("Windows runs both Rust checks and its own bundle, and skips the macOS bundle with a reason", () => {
    const plan = localPlan("win32");
    assert.ok(lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes(NEXTEST));
    assert.ok(lines(plan).some((line) => line.startsWith("web/node_modules/.bin/tauri.cmd build --ci --bundles nsis")));
    assert.match(plan.skipped.find(({ id }) => id === "bundle-macos")?.reason ?? "", /macOS/);
  });

  test("macOS runs both Rust checks and its own bundle, and skips the Windows bundle", () => {
    const plan = localPlan("darwin");
    assert.ok(lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes("web/node_modules/.bin/tauri build --ci --bundles app,dmg"));
    assert.ok(plan.skipped.some(({ id }) => id === "bundle-windows"));
  });

  test("Windows stages the GPU runtime before its bundle, then verifies and probes what was packaged", () => {
    const run = lines(localPlan("win32"));
    const stage = run.indexOf("node tools/dictation-package.mjs stage");
    const bundle = run.indexOf("web/node_modules/.bin/tauri.cmd build --ci --bundles nsis --config crates/oxide-app/tauri.windows-gpu.conf.json");
    const verify = run.indexOf("node tools/dictation-package.mjs verify windows-x64");
    const smoke = run.indexOf("node tools/dictation-package.mjs smoke");
    assert.ok(stage >= 0 && bundle > stage && verify > bundle && smoke > verify, run.join("\n"));
    assert.match(localPlan("win32").skipped.find(({ id }) => id === "dictation-install")?.reason ?? "", /CI only/);
  });

  test("macOS verifies its app bundle and runs no Windows packaging", () => {
    const run = lines(localPlan("darwin"));
    assert.ok(run.indexOf("node tools/dictation-package.mjs verify macos-aarch64") > run.indexOf("web/node_modules/.bin/tauri build --ci --bundles app,dmg"));
    assert.ok(!run.includes("node tools/dictation-package.mjs stage"));
  });

  test("Linux skips the Rust checks and bundles that CI runs on macOS and Windows", () => {
    const plan = localPlan("linux");
    assert.ok(!lines(plan).includes(CLIPPY));
    assert.ok(lines(plan).includes("cargo fmt --all --check"));
    assert.deepEqual(plan.skipped.filter(({ id }) => ["clippy", "rust-test", "bundle-macos", "bundle-windows"].includes(id)).length, 4);
  });

  test("the full tier runs the tooling suite and reports CI-only checks as skipped", () => {
    const plan = localPlan("darwin");
    assert.ok(lines(plan).includes('node --test "tools/**/*.test.mjs"'));
    for (const id of ["cargo-deny", "actionlint", "zizmor", "pr-title"]) assert.ok(plan.skipped.some((entry) => entry.id === id), id);
    for (const { reason } of plan.skipped) assert.ok(reason.length > 0);
  });

  test("fast has only rustfmt, ESLint and TypeScript, on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.deepEqual(lines(localPlan(platform, "fast")), ["cargo fmt --all --check", "pnpm --dir web lint", "pnpm --dir web typecheck"]);
    }
  });

  test("an unknown platform or tier fails", () => {
    assert.throws(() => localPlan("aix"), /platform/);
    assert.throws(() => localPlan("toString"), /platform/);
    assert.throws(() => localPlan("darwin", "slow"), /tier/);
  });

  // The one parity test: green locally must mean the same commands as CI.
  const workflowDir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const workflows = readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).map((name) => readFileSync(join(workflowDir, name), "utf8"));
  test("every local command appears verbatim in a CI workflow", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      // The bundle jobs call the shared build workflow, which lands in CI/CD slice 3 (#238).
      const checks = localPlan(platform).run.filter(({ id }) => !id.startsWith("bundle-") || existsSync(join(workflowDir, "build.yml")));
      for (const line of lines({ run: checks })) {
        assert.ok(workflows.some((workflow) => workflow.includes(line)), `${line} is not in .github/workflows/`);
      }
    }
  });
});

describe("checkDictationPackage", () => {
  // An installed Windows package: Oxide's own executables, both GPU workers, the CUDA
  // runtime they import, the notices and the runtime manifest.
  const WINDOWS = {
    files: [
      "oxide-app.exe", "uninstall.exe", "oxide-vulkan-worker.exe", "oxide-cuda-worker.exe",
      "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll", "dictation-runtime.json",
      "licenses/whisper.txt", "licenses/dictation-fixture.txt", "licenses/cuda.txt", "licenses/msvc-runtime.txt",
    ],
    imports: {
      "oxide-app.exe": ["KERNEL32.dll", "USER32.dll", "ole32.dll", "api-ms-win-core-synch-l1-2-0.dll"],
      "uninstall.exe": ["KERNEL32.dll", "SHELL32.dll"],
      "oxide-vulkan-worker.exe": ["vulkan-1.dll", "KERNEL32.dll", "ntdll.dll", "bcryptprimitives.dll"],
      // nvcuda.dll is delay-loaded, so it is not in the import table.
      "oxide-cuda-worker.exe": ["cudart64_12.dll", "cublas64_12.dll", "KERNEL32.dll", "ADVAPI32.dll"],
      "cudart64_12.dll": ["KERNEL32.dll"],
      "cublas64_12.dll": ["cublasLt64_12.dll", "KERNEL32.dll"],
      "cublasLt64_12.dll": ["KERNEL32.dll", "ADVAPI32.dll"],
    },
  };

  test("a complete Windows install passes", () => {
    const result = checkDictationPackage("windows-x64", WINDOWS);
    assert.equal(result.ok, true, result.message);
  });

  test("a missing worker or CUDA runtime DLL fails and names it", () => {
    for (const file of ["oxide-cuda-worker.exe", "cublasLt64_12.dll", "licenses/cuda.txt", "licenses/msvc-runtime.txt"]) {
      const result = checkDictationPackage("windows-x64", { ...WINDOWS, files: WINDOWS.files.filter((name) => name !== file) });
      assert.equal(result.ok, false);
      assert.match(result.message, new RegExp(`${file.replace(".", "\\.")} is missing`));
    }
  });

  test("a bundled graphics driver fails: drivers come from the GPU vendor, never from Oxide", () => {
    for (const driver of ["nvcuda.dll", "vulkan-1.dll"]) {
      const result = checkDictationPackage("windows-x64", { ...WINDOWS, files: [...WINDOWS.files, driver] });
      assert.equal(result.ok, false);
      assert.match(result.message, new RegExp(`${driver.replace(".", "\\.")} is a graphics driver`));
    }
  });

  const importing = (exe, dll) => ({ ...WINDOWS, imports: { ...WINDOWS.imports, [exe]: [...WINDOWS.imports[exe], dll] } });

  test("both GPU workers may import the Windows Performance Data Helper without bundling it", () => {
    // PR #265's installed workers both import pdh.dll from Windows.
    for (const worker of ["oxide-cuda-worker.exe", "oxide-vulkan-worker.exe"]) {
      for (const dll of ["pdh.dll", "PDH.DLL"]) {
        const result = checkDictationPackage("windows-x64", importing(worker, dll));
        assert.equal(result.ok, true, result.message);
      }
    }
  });

  test("the host never loads a GPU runtime or driver, so it starts on any machine", () => {
    for (const dll of ["vulkan-1.dll", "NVCUDA.dll", "cudart64_12.dll", "cublas64_12.dll"]) {
      const result = checkDictationPackage("windows-x64", importing("oxide-app.exe", dll));
      assert.equal(result.ok, false, dll);
      assert.match(result.message, /oxide-app\.exe imports .* only a GPU worker may load it/i);
    }
  });

  test("a worker may load only its own backend's driver", () => {
    const result = checkDictationPackage("windows-x64", importing("oxide-vulkan-worker.exe", "nvcuda.dll"));
    assert.equal(result.ok, false);
    assert.match(result.message, /oxide-vulkan-worker\.exe imports nvcuda\.dll/);
  });

  test("the CUDA worker must delay-load nvcuda.dll, so it can answer on a machine without the driver", () => {
    const result = checkDictationPackage("windows-x64", importing("oxide-cuda-worker.exe", "nvcuda.dll"));
    assert.equal(result.ok, false);
    assert.match(result.message, /oxide-cuda-worker\.exe imports nvcuda\.dll directly: delay-load it/);
  });

  test("a worker's non-system import must be bundled beside it", () => {
    const result = checkDictationPackage("windows-x64", importing("oxide-cuda-worker.exe", "cufft64_11.dll"));
    assert.equal(result.ok, false);
    assert.match(result.message, /oxide-cuda-worker\.exe imports cufft64_11\.dll, which is neither a Windows system DLL nor bundled/);
  });

  test("a worker that needs the Visual C++ runtime passes only with it bundled beside it", () => {
    for (const dll of ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "MSVCP140.dll"]) {
      const result = checkDictationPackage("windows-x64", importing("oxide-vulkan-worker.exe", dll));
      assert.equal(result.ok, false, dll);
      assert.match(result.message, /Visual C\+\+ runtime: stage it beside the worker/);
    }
    const bundled = importing("oxide-vulkan-worker.exe", "MSVCP140.dll");
    bundled.files = [...bundled.files, "msvcp140.dll", "vcruntime140.dll"];
    bundled.imports = { ...bundled.imports, "msvcp140.dll": ["VCRUNTIME140.dll", "KERNEL32.dll"], "vcruntime140.dll": ["KERNEL32.dll"] };
    const result = checkDictationPackage("windows-x64", bundled);
    assert.equal(result.ok, true, result.message);
  });

  test("a bundled DLL's own imports must resolve too", () => {
    const result = checkDictationPackage("windows-x64", {
      ...WINDOWS, files: WINDOWS.files.filter((file) => file !== "cublasLt64_12.dll"),
    });
    assert.match(result.message, /cublas64_12\.dll imports cublaslt64_12\.dll, which is neither a Windows system DLL nor bundled/);
  });

  test("an executable whose imports could not be read fails instead of passing unchecked", () => {
    const { "oxide-cuda-worker.exe": _, ...rest } = WINDOWS.imports;
    const result = checkDictationPackage("windows-x64", { ...WINDOWS, imports: rest });
    assert.equal(result.ok, false);
    assert.match(result.message, /oxide-cuda-worker\.exe: imports were not read/);
  });

  // Paths relative to Oxide.app/Contents. Metal is linked into the app itself.
  const MACOS = {
    files: ["Info.plist", "MacOS/oxide-app", "Resources/licenses/whisper.txt", "Resources/licenses/dictation-fixture.txt"],
    imports: {
      "MacOS/oxide-app": [
        "/System/Library/Frameworks/Metal.framework/Versions/A/Metal", "/usr/lib/libc++.1.dylib", "/usr/lib/libSystem.B.dylib",
      ],
    },
    sections: { "MacOS/oxide-app": ["__TEXT,__text", "__DATA,__ggml_metallib"] },
    infoPlist: "<key>NSMicrophoneUsageDescription</key><string>Oxide uses the microphone for local dictation.</string>",
  };

  test("a complete Apple Silicon app passes", () => {
    const result = checkDictationPackage("macos-aarch64", MACOS);
    assert.equal(result.ok, true, result.message);
  });

  test("an app that links a library outside macOS fails, because users do not have it", () => {
    for (const library of ["/opt/homebrew/lib/libvulkan.1.dylib", "@rpath/libggml-metal.dylib"]) {
      const result = checkDictationPackage("macos-aarch64", { ...MACOS, imports: { "MacOS/oxide-app": [...MACOS.imports["MacOS/oxide-app"], library] } });
      assert.equal(result.ok, false, library);
      assert.match(result.message, /links .* outside macOS/);
    }
  });

  test("an app without the embedded Metal library fails: Metal would need shader files the bundle lacks", () => {
    const result = checkDictationPackage("macos-aarch64", { ...MACOS, sections: { "MacOS/oxide-app": ["__TEXT,__text"] } });
    assert.equal(result.ok, false);
    assert.match(result.message, /embedded Metal library/);
  });

  test("an app without the microphone description or the notices fails", () => {
    assert.match(checkDictationPackage("macos-aarch64", { ...MACOS, infoPlist: "<dict></dict>" }).message, /NSMicrophoneUsageDescription/);
    const files = MACOS.files.filter((file) => file !== "Resources/licenses/whisper.txt");
    assert.match(checkDictationPackage("macos-aarch64", { ...MACOS, files }).message, /Resources\/licenses\/whisper\.txt is missing/);
  });
});

describe("checkWorkerProbe", () => {
  const probe = (result, overrides = {}) => ({
    worker: "oxide-vulkan-worker.exe", status: 0, engineVersion: "1.8.3",
    response: { protocol_version: 1, engine_version: "1.8.3", result }, ...overrides,
  });

  test("a worker that enumerates adapters or reports a typed capability state answered correctly", () => {
    const listed = checkWorkerProbe(probe({ Ok: { Adapters: [{ id: "vulkan:1", name: "AMD Radeon RX 5600 XT", capability: { status: "available" } }] } }));
    assert.equal(listed.ok, true);
    assert.match(listed.message, /oxide-vulkan-worker\.exe started and found 1 adapter: AMD Radeon RX 5600 XT \(available\)/);
    assert.match(checkWorkerProbe(probe({ Ok: { Adapters: [] } })).message, /found no adapter/);
    const missing = checkWorkerProbe(probe({ Err: { Unavailable: { status: "missingDriverOrRuntime" } } }));
    assert.equal(missing.ok, true);
    assert.match(missing.message, /started and reported missingDriverOrRuntime/);
  });

  test("the Windows loader refusing a missing driver DLL leaves only that backend unavailable", () => {
    for (const status of [0xc0000135, -1073741515]) {
      const result = checkWorkerProbe({ worker: "oxide-vulkan-worker.exe", status, engineVersion: "1.8.3" });
      assert.equal(result.ok, true);
      assert.match(result.message, /oxide-vulkan-worker\.exe: the graphics driver is not installed/);
    }
  });

  test("the CUDA worker delay-loads its driver, so a DLL it cannot find is a bundled one", () => {
    const result = checkWorkerProbe({ worker: "oxide-cuda-worker.exe", status: 0xc0000135, engineVersion: "1.8.3" });
    assert.equal(result.ok, false);
    assert.match(result.message, /a bundled DLL failed to load/);
  });

  test("a crash, a timeout, a malformed answer or a different engine fails", () => {
    assert.equal(checkWorkerProbe(probe(undefined, { status: 0xc0000005, response: undefined })).ok, false);
    assert.match(checkWorkerProbe(probe(undefined, { status: null, response: undefined })).message, /did not finish/);
    assert.match(checkWorkerProbe(probe(undefined, { response: undefined })).message, /no valid answer/);
    assert.match(checkWorkerProbe(probe({ Ok: { Adapters: [] } }, { engineVersion: "1.8.4" })).message, /engine 1\.8\.3, expected 1\.8\.4/);
    assert.match(checkWorkerProbe(probe({ Ok: { Adapters: [] } }, { response: { protocol_version: 2, engine_version: "1.8.3", result: { Ok: { Adapters: [] } } } })).message, /protocol 2/);
  });
});

describe("runtimeManifestProblems", () => {
  test("catches a staged file that changed or disappeared before packaging", () => {
    const manifest = { files: [{ path: "oxide-cuda-worker.exe", sha256: "a".repeat(64) }, { path: "cudart64_12.dll", sha256: "b".repeat(64) }] };
    assert.deepEqual(runtimeManifestProblems(manifest, { "oxide-cuda-worker.exe": "a".repeat(64), "cudart64_12.dll": "b".repeat(64) }), []);
    assert.deepEqual(runtimeManifestProblems(manifest, { "oxide-cuda-worker.exe": "c".repeat(64) }), [
      "oxide-cuda-worker.exe differs from the staged build",
      "cudart64_12.dll is listed in dictation-runtime.json but missing",
    ]);
    assert.deepEqual(runtimeManifestProblems(undefined, {}), ["dictation-runtime.json is missing or unreadable"]);
  });
});

describe("checkAppLaunch", () => {
  test("an app still running, or closed normally, started", () => {
    assert.equal(checkAppLaunch({ app: "oxide-app.exe", running: true, seconds: 15 }).ok, true);
    assert.match(checkAppLaunch({ app: "oxide-app.exe", running: true, seconds: 15 }).message, /still running after 15 s/);
    assert.equal(checkAppLaunch({ app: "oxide-app.exe", running: false, exitCode: 0, seconds: 15 }).ok, true);
  });

  test("an app that could not start, or died during startup, fails with the reason", () => {
    assert.match(checkAppLaunch({ app: "oxide-app.exe", running: false, exitCode: 0xc0000135, seconds: 15 }).message, /exited 0xc0000135 during startup/);
    assert.match(checkAppLaunch({ app: "oxide-app.exe", running: false, error: "spawn EACCES", seconds: 15 }).message, /could not start: spawn EACCES/);
    assert.match(checkAppLaunch({ running: false, seconds: 15 }).message, /no app executable/);
  });
});

describe("GPU_BUILD_SDKS", () => {
  test("each build SDK is a pinned HTTPS installer with a SHA-256", () => {
    for (const [name, sdk] of Object.entries(GPU_BUILD_SDKS)) {
      assert.match(sdk.url, /^https:\/\/(developer\.download\.nvidia\.com|sdk\.lunarg\.com)\//, name);
      assert.ok(sdk.url.includes(sdk.version), `${name} URL must name version ${sdk.version}`);
      assert.match(sdk.sha256, /^[0-9a-f]{64}$/, name);
    }
  });

  test("the CUDA Toolkit major version matches the runtime DLLs the Windows package requires", () => {
    const major = GPU_BUILD_SDKS.cuda.version.split(".")[0];
    const required = checkDictationPackage("windows-x64", { files: [], imports: {} }).problems.join(" ");
    for (const dll of ["cudart", "cublas", "cublasLt"].map((name) => `${name}64_${major}.dll`)) {
      assert.match(required, new RegExp(`${dll.replace(".", "\\.")} is missing`));
    }
  });

  test("CUDA installs only the compiler, runtime and cuBLAS components, without a display driver", () => {
    const { components } = GPU_BUILD_SDKS.cuda;
    for (const needed of ["nvcc", "cudart", "cublas", "cublas_dev"]) assert.ok(components.some((name) => name.startsWith(`${needed}_`)), needed);
    assert.ok(!components.some((name) => /driver/i.test(name)));
  });
});
