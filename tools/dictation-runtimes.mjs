// Downloadable dictation runtimes: package, index, sign and verify. See docs/devops.md ("Runtime packages").
//
//   node tools/dictation-runtimes.mjs keygen <secret-file>             a new signing key pair; the secret goes to CI, the public key into runtimes.rs
//   node tools/dictation-runtimes.mjs package [staged-dir] [out-dir]   one zip per backend from the staged folders (after `dictation-package.mjs stage`)
//   node tools/dictation-runtimes.mjs index <dir> <tag> [owner/repo]   runtimes-index.json for the zips in <dir>, signed when RUNTIME_SIGNING_KEY is set
//   node tools/dictation-runtimes.mjs verify <dir> [tag]               zips, index and signature against each other and the key embedded in the app
//
// RUNTIME_SIGNING_KEY is the secret printed by `keygen`; it is only ever read from the environment.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { peImports } from "./checks/pe-imports.mjs";
import { generateSigningKey, publicKeyOf, readZipFlat, signMinisign, verifyMinisign, zipFlat } from "./checks/runtime-release.mjs";
import {
  checkRuntimePackage, RUNTIME_BACKENDS, runtimeAssetName, runtimeIndex, runtimePackageManifest,
} from "./ci/policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const STAGED = join(repoRoot, "target", "dictation-runtime", "windows-x64");
export const PACKAGES = join(repoRoot, "target", "dictation-runtime", "packages");
const INDEX_FILE = "runtimes-index.json";
const SIGNATURE_FILE = `${INDEX_FILE}.minisig`;
const CORE_SOURCE = join(repoRoot, "crates/oxide-core/src/dictation/runtimes.rs");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const appVersion = () => JSON.parse(readFileSync(join(repoRoot, "crates/oxide-app/tauri.conf.json"), "utf8")).version;

/** The public key the app trusts, read from the core's source so CI signs for the key that ships. */
export function embeddedPublicKey(source = readFileSync(CORE_SOURCE, "utf8")) {
  const key = source.match(/RUNTIME_PUBLIC_KEY: &str = "([^"]+)"/)?.[1];
  if (!key) throw new Error("RUNTIME_PUBLIC_KEY is missing from crates/oxide-core/src/dictation/runtimes.rs.");
  return key;
}

function inspect(entries, importsOf = peImports) {
  const files = entries.map(([name]) => name);
  const hashes = Object.fromEntries(entries.map(([name, content]) => [name, sha256(content)]));
  const imports = {};
  for (const [name, content] of entries.filter(([name]) => /\.(exe|dll)$/i.test(name))) {
    try { imports[name] = importsOf(content); } catch { /* reported as unread */ }
  }
  const manifestEntry = entries.find(([name]) => name === "manifest.json");
  let manifest;
  try { manifest = manifestEntry && JSON.parse(manifestEntry[1].toString("utf8")); } catch { /* unreadable */ }
  return { manifest, files, hashes, imports };
}

function keygen(secretFile) {
  if (!secretFile) throw new Error("Usage: keygen <secret-file>");
  if (existsSync(secretFile)) throw new Error(`${secretFile} exists: it is not overwritten.`);
  const { secretKey, publicKey } = generateSigningKey();
  writeFileSync(secretFile, `${secretKey}\n`, { mode: 0o600, flag: "wx" });
  console.log(`Secret key written to ${secretFile}. Store it as the RUNTIME_SIGNING_KEY secret of the release environment, then delete the file.`);
  console.log(`Public key (for RUNTIME_PUBLIC_KEY in crates/oxide-core/src/dictation/runtimes.rs):\n${publicKey}`);
}

/** Zip each staged backend folder, adding the manifest. Refuses a package the core would refuse. */
function packageRuntimes(stagedDir = STAGED, outDir = PACKAGES) {
  const version = appVersion();
  mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const backend of Object.keys(RUNTIME_BACKENDS)) {
    const folder = join(stagedDir, backend);
    if (!existsSync(folder)) throw new Error(`${folder} is missing: run "node tools/dictation-package.mjs stage" first.`);
    const entries = readdirSync(folder, { withFileTypes: true }).map((entry) => {
      if (!entry.isFile()) throw new Error(`${join(folder, entry.name)} is not a file: a runtime package is flat.`);
      return [entry.name, readFileSync(join(folder, entry.name))];
    }).filter(([name]) => name !== "manifest.json");
    const manifest = runtimePackageManifest({ backend, version, hashes: Object.fromEntries(entries.map(([name, content]) => [name, sha256(content)])) });
    const all = [...entries, ["manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]];
    const verdict = checkRuntimePackage(backend, inspect(all));
    if (!verdict.ok) throw new Error(verdict.message);
    const zip = zipFlat(all);
    const name = runtimeAssetName(backend, version);
    writeFileSync(join(outDir, name), zip);
    built.push({ backend, name, bytes: zip.length, sha256: sha256(zip) });
    console.log(`${String(zip.length).padStart(12)}  ${name}  ${verdict.message}`);
  }
  return built;
}

function packagesIn(dir) {
  return Object.keys(RUNTIME_BACKENDS).map((backend) => {
    const pattern = new RegExp(`^oxide-runtime-${backend}-windows-x64-.+\\.zip$`);
    const names = readdirSync(dir).filter((name) => pattern.test(name));
    if (names.length !== 1) throw new Error(`Expected one ${backend} package in ${dir}, found ${names.length}.`);
    const zip = readFileSync(join(dir, names[0]));
    return { backend, name: names[0], zip, bytes: zip.length, sha256: sha256(zip) };
  });
}

function index(dir, tag, repository = "cavallinilorenzo/oxide") {
  if (!dir || !tag) throw new Error("Usage: index <dir> <tag> [owner/repo]");
  const packages = packagesIn(dir);
  const document = `${JSON.stringify(runtimeIndex(packages, { repository, tag }), null, 2)}\n`;
  writeFileSync(join(dir, INDEX_FILE), document);
  console.log(`Wrote ${join(dir, INDEX_FILE)} for ${packages.map(({ name }) => name).join(", ")}.`);
  const secret = process.env.RUNTIME_SIGNING_KEY;
  if (!secret) {
    console.log("RUNTIME_SIGNING_KEY is not set: the index is not signed.");
    return;
  }
  if (publicKeyOf(secret) !== embeddedPublicKey()) {
    throw new Error("RUNTIME_SIGNING_KEY does not match RUNTIME_PUBLIC_KEY in the app: installed apps would reject this index. Not signing.");
  }
  writeFileSync(join(dir, SIGNATURE_FILE), signMinisign(secret, Buffer.from(document), `oxide runtimes ${tag}`));
  console.log(`Signed: ${join(dir, SIGNATURE_FILE)}`);
}

/** Everything the app checks, from the published files alone. Returns the problems. */
export function verifyRelease(dir, tag, publicKey = embeddedPublicKey(), { importsOf } = {}) {
  const problems = [];
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : undefined);
  const document = read(INDEX_FILE);
  const signature = read(SIGNATURE_FILE);
  if (!document) return [`${INDEX_FILE} is missing`];
  if (!signature) return [`${SIGNATURE_FILE} is missing`];
  if (!verifyMinisign(publicKey, document, signature.toString("utf8"))) return [`${SIGNATURE_FILE} is not a valid signature of ${INDEX_FILE} by the key embedded in the app`];
  const parsed = JSON.parse(document.toString("utf8"));
  for (const backend of Object.keys(RUNTIME_BACKENDS)) {
    const entry = parsed.runtimes?.find((candidate) => candidate.backend === backend);
    if (!entry) { problems.push(`${INDEX_FILE} lists no ${backend} runtime`); continue; }
    if (tag && entry.version !== tag.replace(/^v/, "")) problems.push(`${backend}: the index lists version ${entry.version}, not ${tag}`);
    const name = entry.url.split("/").pop();
    const zip = read(name);
    if (!zip) { problems.push(`${name} is missing`); continue; }
    if (entry.bytes !== zip.length) problems.push(`${name} is ${zip.length} bytes, the index says ${entry.bytes}`);
    if (entry.sha256 !== sha256(zip)) problems.push(`${name} does not match the SHA-256 in the index`);
    try {
      const verdict = checkRuntimePackage(backend, inspect(readZipFlat(zip), importsOf));
      if (!verdict.ok) problems.push(...verdict.problems.map((problem) => `${name}: ${problem}`));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  return problems;
}

function verify(dir, tag) {
  if (!dir) throw new Error("Usage: verify <dir> [tag]");
  const problems = verifyRelease(dir, tag);
  if (problems.length > 0) {
    console.error(`${dir}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    return 1;
  }
  console.log(`${dir}: the index is signed by the app's key and every runtime package matches it.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "keygen") keygen(args[0]);
    else if (command === "package") packageRuntimes(args[0] && resolve(args[0]), args[1] && resolve(args[1]));
    else if (command === "index") index(args[0] && resolve(args[0]), args[1], args[2]);
    else if (command === "verify") process.exitCode = verify(args[0] && resolve(args[0]), args[1]);
    else {
      console.error("Usage: node tools/dictation-runtimes.mjs keygen <file> | package [staged] [out] | index <dir> <tag> [owner/repo] | verify <dir> [tag]");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
