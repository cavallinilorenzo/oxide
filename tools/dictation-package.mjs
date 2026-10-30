// Dictation packaging: the Windows GPU workers and their runtime, and checks of
// what an installer or app bundle actually contains. See docs/dictation.md#packaging-and-distribution.
//
//   node tools/dictation-package.mjs setup                       Windows, elevated: install the pinned CUDA Toolkit and Vulkan SDK
//   node tools/dictation-package.mjs stage                       Windows, x64 Native Tools prompt: build the release workers and
//                                                                stage them with their runtime for tauri.windows-gpu.conf.json
//   node tools/dictation-package.mjs verify windows-x64 [dir]    an installed folder (default: the built <target>/release)
//   node tools/dictation-package.mjs verify macos-aarch64 [app]  default: <target>/release/bundle/macos/Oxide.app
//   node tools/dictation-package.mjs smoke [dir] [--launch]      Windows: probe each packaged worker with no SDK on PATH;
//                                                                --launch also starts the app (CI)
//
// <target> is CARGO_TARGET_DIR, or target/ in the repository.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { assertBuildSpace } from "./checks/build-space.mjs";
import { peImports } from "./checks/pe-imports.mjs";
import { checkDictationPackage, checkWorkerProbe, GPU_BUILD_SDKS } from "./ci/policy.mjs";
import { releaseWorker } from "./dictation-build.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// Fixed, so tauri.windows-gpu.conf.json can name each staged file.
export const STAGING = join(repoRoot, "target", "dictation-runtime", "windows-x64");
const MANIFEST = "dictation-runtime.json";
const WORKERS = { vulkan: "oxide-vulkan-worker.exe", cuda: "oxide-cuda-worker.exe" };
// Redistributable per the NVIDIA CUDA EULA (Attachment A); see docs/licenses/cuda.txt.
const CUDA_REDISTRIBUTABLE = /^(cudart|cublas|cublasLt)64_\d+\.dll$/i;

/**
 * The redistributable DLLs `roots` load, directly or through each other.
 * `sources` maps a lower-case DLL name to the file to stage; anything not in it
 * (system DLLs, drivers) stays where Windows has it.
 */
export function runtimeFiles(roots, sources, importsOf) {
  const staged = new Map();
  const pending = [...roots];
  while (pending.length > 0) {
    for (const dll of importsOf(pending.pop()) ?? []) {
      const from = sources.get(dll.toLowerCase());
      if (!from || staged.has(dll.toLowerCase())) continue;
      staged.set(dll.toLowerCase(), { name: basename(from), from });
      pending.push(from);
    }
  }
  return [...staged.values()];
}

/** What changed between staging and packaging. `hashes` maps each present file to its SHA-256. */
export function manifestProblems(manifest, hashes) {
  if (!Array.isArray(manifest?.files)) return [`${MANIFEST} is missing or unreadable`];
  return manifest.files.flatMap(({ path, sha256 }) => {
    if (!(path in hashes)) return [`${path} is listed in ${MANIFEST} but missing`];
    return hashes[path] === sha256 ? [] : [`${path} differs from the staged build`];
  });
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const targetDir = () => resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "target");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args.join(" ")} exited ${result.status}`);
}

function requireWindows(what) {
  if (process.platform !== "win32") throw new Error(`${what} runs on Windows x64 only.`);
}

async function download({ url, sha256: expected }, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  const hash = createHash("sha256");
  await pipeline(Readable.fromWeb(response.body), async function* (chunks) {
    for await (const chunk of chunks) { hash.update(chunk); yield chunk; }
  }, createWriteStream(file));
  const actual = hash.digest("hex");
  if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, expected ${expected}. Not installing it.`);
}

/** Install the pinned build SDKs. End users never need them. */
async function setup() {
  requireWindows("setup");
  const { cuda, vulkan } = GPU_BUILD_SDKS;
  const scratch = mkdtempSync(join(tmpdir(), "oxide-gpu-sdks-"));
  try {
    const cudaInstaller = join(scratch, "cuda.exe");
    const vulkanInstaller = join(scratch, "vulkan.exe");
    await download(cuda, cudaInstaller);
    await download(vulkan, vulkanInstaller);
    console.log(`Installing CUDA Toolkit ${cuda.version} (${cuda.components.join(", ")})`);
    run(cudaInstaller, ["-s", ...cuda.components, "-n"]);
    const vulkanRoot = `C:\\VulkanSDK\\${vulkan.version}`;
    console.log(`Installing Vulkan SDK ${vulkan.version} into ${vulkanRoot}`);
    run(vulkanInstaller, ["--root", vulkanRoot, "--accept-licenses", "--default-answer", "--confirm-command", "install"]);
    const cudaRoot = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\NVIDIA GPU Computing Toolkit\\CUDA\\v${cuda.version.split(".").slice(0, 2).join(".")}`;
    const env = { CUDA_PATH: cudaRoot, VULKAN_SDK: vulkanRoot };
    const path = [`${cudaRoot}\\bin`, `${vulkanRoot}\\Bin`];
    if (process.env.GITHUB_ENV) {
      writeFileSync(process.env.GITHUB_ENV, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
      writeFileSync(process.env.GITHUB_PATH, path.map((entry) => `${entry}\n`).join(""), { flag: "a" });
    }
    console.log(`Done. Open a new x64 Native Tools prompt, or set:\n${Object.entries(env).map(([key, value]) => `  set ${key}=${value}`).join("\n")}\n  set PATH=${path.join(";")};%PATH%`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The DLLs a worker may need staged: the CUDA runtime and the Visual C++ runtime.
function runtimeSources(env) {
  const sources = new Map();
  const cudaBin = join(env.CUDA_PATH, "bin");
  for (const name of readdirSync(cudaBin)) {
    if (CUDA_REDISTRIBUTABLE.test(name)) sources.set(name.toLowerCase(), join(cudaBin, name));
  }
  // vcvars sets VCToolsRedistDir; Microsoft permits app-local copies of these DLLs.
  const redist = join(env.VCToolsRedistDir, "x64");
  for (const crt of readdirSync(redist).filter((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))) {
    for (const name of readdirSync(join(redist, crt))) {
      if (/\.dll$/i.test(name)) sources.set(name.toLowerCase(), join(redist, crt, name));
    }
  }
  return sources;
}

function nativeVersions() {
  const lock = readFileSync(join(repoRoot, "crates/oxide-cuda-worker/Cargo.lock"), "utf8").replace(/\r\n/g, "\n");
  const version = (name) => lock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`))?.[1];
  const engine = readFileSync(join(repoRoot, "crates/oxide-core/src/dictation/cuda.rs"), "utf8").match(/ENGINE_VERSION: &str = "([^"]+)"/)?.[1];
  return { whisperRs: version("whisper-rs"), whisperRsSys: version("whisper-rs-sys"), whisperCpp: engine };
}

/** Build both release workers and stage them, their runtime and the manifest. */
function stage() {
  requireWindows("stage");
  for (const variable of ["CUDA_PATH", "VULKAN_SDK", "VCToolsRedistDir"]) {
    if (!process.env[variable]) {
      throw new Error(`${variable} is not set: run "node tools/dictation-package.mjs setup", then use an x64 Native Tools prompt (docs/dictation.md).`);
    }
  }
  for (const tool of ["cl.exe", "cmake.exe", "ninja.exe", "glslc.exe", "nvcc.exe"]) {
    if (spawnSync("where.exe", [tool], { stdio: "ignore" }).status !== 0) throw new Error(`Missing ${tool}: see docs/dictation.md#packaging-and-distribution`);
  }
  const built = Object.keys(WORKERS).map((backend) => {
    const worker = releaseWorker(backend);
    assertBuildSpace(repoRoot);
    run("cargo", worker.args, { cwd: repoRoot, env: worker.env });
    return worker.exe;
  });
  assertBuildSpace(repoRoot);

  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING, { recursive: true });
  const runtime = runtimeFiles(built, runtimeSources(process.env), (path) => peImports(readFileSync(path)));
  for (const from of built) copyFileSync(from, join(STAGING, basename(from)));
  for (const { name, from } of runtime) copyFileSync(from, join(STAGING, name));

  const files = readdirSync(STAGING).sort().map((path) => ({ path, bytes: statSync(join(STAGING, path)).size, sha256: sha256(join(STAGING, path)) }));
  const manifest = {
    schema: 1,
    platform: "windows-x64",
    native: nativeVersions(),
    build: { ggmlNative: "OFF", cudaToolkit: basename(process.env.CUDA_PATH), vulkanSdk: basename(process.env.VULKAN_SDK) },
    backends: [
      { id: "cpu", in: "oxide-app.exe", requires: "an x64 CPU with AVX2, FMA and F16C" },
      { id: "vulkan", worker: WORKERS.vulkan, requires: "a Vulkan 1.2 driver with 16-bit storage and timestamp queries" },
      { id: "cuda", worker: WORKERS.cuda, requires: `an NVIDIA driver for CUDA ${GPU_BUILD_SDKS.cuda.version} and compute capability 5.0 or later` },
    ],
    files,
  };
  writeFileSync(join(STAGING, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const { path, bytes } of files) console.log(`${String(bytes).padStart(12)}  ${path}`);
  console.log(`Staged in ${STAGING}. Bundle with: tauri build --bundles nsis --config crates/oxide-app/tauri.windows-gpu.conf.json`);
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listFiles(root, path);
    return entry.isFile() ? [relative(root, path).replaceAll("\\", "/")] : [];
  });
}

function windowsInventory(dir) {
  // The install folder; a built target/release also holds build-only files, which are skipped.
  const shipped = readdirSync(dir).filter((name) => /\.(exe|dll|json)$/i.test(name) && statSync(join(dir, name)).isFile());
  const licenses = existsSync(join(dir, "licenses")) ? listFiles(dir, join(dir, "licenses")) : [];
  const imports = {};
  for (const name of shipped.filter((file) => /\.(exe|dll)$/i.test(file))) {
    try { imports[name] = peImports(readFileSync(join(dir, name))); } catch { /* reported as unread */ }
  }
  return { files: [...shipped, ...licenses], imports };
}

function macosInventory(app) {
  const contents = join(app, "Contents");
  const files = listFiles(contents);
  const imports = {};
  const sections = {};
  for (const exe of files.filter((file) => /^MacOS\/[^/]+$/.test(file))) {
    const path = join(contents, exe);
    // The first line names the file; each further line is "<library> (compatibility version …)".
    imports[exe] = spawnSync("otool", ["-L", path], { encoding: "utf8" }).stdout.split("\n").slice(1)
      .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, "")).filter(Boolean);
    const commands = spawnSync("otool", ["-l", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
    sections[exe] = [...commands.matchAll(/sectname (\S+)\n\s+segname (\S+)/g)].map(([, section, segment]) => `${segment},${section}`);
  }
  const plist = join(contents, "Info.plist");
  return { files, imports, sections, infoPlist: existsSync(plist) ? readFileSync(plist, "utf8") : "" };
}

function verify(platform, location) {
  if (platform === "windows-x64") {
    const dir = resolve(location ?? join(targetDir(), "release"));
    const inventory = windowsInventory(dir);
    const result = checkDictationPackage(platform, inventory);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")); } catch { manifest = undefined; }
    const hashes = Object.fromEntries((manifest?.files ?? []).filter(({ path }) => existsSync(join(dir, path))).map(({ path }) => [path, sha256(join(dir, path))]));
    const problems = [...result.problems, ...manifestProblems(manifest, hashes)];
    return report(problems, result.message, dir);
  }
  if (platform === "macos-aarch64") {
    const app = resolve(location ?? join(targetDir(), "release", "bundle", "macos", "Oxide.app"));
    if (!existsSync(join(app, "Contents"))) return report([`${app} is not an app bundle: build it first`], "", app);
    const result = checkDictationPackage(platform, macosInventory(app));
    return report(result.problems, result.message, app);
  }
  throw new Error(`Unknown platform "${platform}": use windows-x64 or macos-aarch64.`);
}

function report(problems, message, where) {
  if (problems.length > 0) {
    console.error(`${where}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    return 1;
  }
  console.log(`${where}: ${message}`);
  return 0;
}

const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
};

function parseFrame(stdout) {
  if (!stdout || stdout.length < 4) return undefined;
  const size = stdout.readUInt32LE(0);
  try { return JSON.parse(stdout.subarray(4, 4 + size).toString("utf8")); } catch { return undefined; }
}

// An end user's environment: no GPU SDK variables, and only Windows' own folders on PATH.
function endUserEnv() {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|cuda_|vulkan_sdk|vk_|ggml_)/i.test(key)));
  return { ...env, PATH: `${root}\\System32;${root};${root}\\System32\\Wbem` };
}

const LAUNCH_SECONDS = 15;

// The installed app must start, and stay up, with no GPU runtime it could load.
async function launchHost(dir, env) {
  const host = readdirSync(dir).find((name) => /\.exe$/i.test(name) && !/^(uninstall|oxide-\w+-worker)\.exe$/i.test(name));
  if (!host) return `no app executable in ${dir}`;
  const child = spawn(join(dir, host), [], { cwd: dir, env, stdio: "ignore", windowsHide: true });
  const exited = await Promise.race([
    new Promise((done) => child.once("exit", (code) => done({ code }))),
    new Promise((done) => child.once("error", (error) => done({ error }))),
    new Promise((done) => setTimeout(() => done(undefined), LAUNCH_SECONDS * 1000)),
  ]);
  if (!exited) {
    child.kill();
    console.log(`${host} started and was still running after ${LAUNCH_SECONDS} s`);
    return undefined;
  }
  if (exited.error) return `${host} could not start: ${exited.error.message}`;
  if (exited.code === 0) {
    console.log(`${host} started and exited normally`);
    return undefined;
  }
  return `${host} exited 0x${(exited.code >>> 0).toString(16)} during startup`;
}

/**
 * Probe each packaged worker as an end user's machine would: no SDK, no developer
 * PATH. `--launch` also starts the installed app (CI does, on a machine with no GPU).
 */
async function smoke(location, { launch = false } = {}) {
  requireWindows("smoke");
  const dir = resolve(location ?? join(targetDir(), "release"));
  let engineVersion;
  try { engineVersion = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")).native.whisperCpp; } catch { /* checked below */ }
  if (!engineVersion) return report([`${MANIFEST} is missing or names no whisper.cpp version`], "", dir);
  const env = endUserEnv();
  let failed = 0;
  for (const worker of Object.values(WORKERS)) {
    const path = join(dir, worker);
    if (!existsSync(path)) {
      console.error(`${worker}: missing from ${dir}`);
      failed++;
      continue;
    }
    const result = spawnSync(path, ["--stdio"], { cwd: tmpdir(), env, input: frame("Probe"), timeout: 30_000, windowsHide: true });
    const verdict = checkWorkerProbe({ worker, status: result.status, response: parseFrame(result.stdout), engineVersion });
    if (verdict.ok) console.log(verdict.message);
    else {
      console.error(`${verdict.message}\n${String(result.stderr ?? "").slice(0, 4000)}`);
      failed++;
    }
  }
  if (launch) {
    const problem = await launchHost(dir, env);
    if (problem) {
      console.error(problem);
      failed++;
    }
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "setup") await setup();
    else if (command === "stage") stage();
    else if (command === "verify") process.exitCode = verify(args[0], args[1]);
    else if (command === "smoke") {
      const launch = args.includes("--launch");
      process.exitCode = await smoke(args.find((arg) => arg !== "--launch"), { launch });
    } else {
      console.error("Usage: node tools/dictation-package.mjs setup | stage | verify <windows-x64|macos-aarch64> [path] | smoke [dir] [--launch]");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
