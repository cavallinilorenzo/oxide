import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkDictationPackage, checkRuntimePackage, CUDA_RUNTIME, lanesFor, runtimeAssetName, runtimeIndex, runtimeIndexUrl, runtimePackageManifest,
  RUNTIME_PLATFORM, RUNTIME_PROTOCOL,
} from "./policy.mjs";

const rustSource = readFileSync(fileURLToPath(new URL("../../crates/oxide-core/src/dictation/runtimes.rs", import.meta.url)), "utf8");

describe("the CPU-only Windows installer", () => {
  const INSTALLED = {
    files: ["oxide-app.exe", "uninstall.exe", "licenses/whisper.txt", "licenses/dictation-fixture.txt"],
    imports: {
      "oxide-app.exe": ["KERNEL32.dll", "USER32.dll", "ole32.dll", "api-ms-win-core-synch-l1-2-0.dll"],
      "uninstall.exe": ["KERNEL32.dll", "SHELL32.dll"],
    },
  };

  test("an installer with the app and its notices passes, and needs no GPU file", () => {
    const result = checkDictationPackage("windows-x64", INSTALLED);
    assert.equal(result.ok, true, result.message);
  });

  test("a worker, a CUDA DLL or a runtime manifest in the installer fails: GPU code comes from a runtime package", () => {
    for (const file of ["oxide-vulkan-worker.exe", "oxide-cuda-worker.exe", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll", "dictation-runtime.json"]) {
      const result = checkDictationPackage("windows-x64", { ...INSTALLED, files: [...INSTALLED.files, file], imports: { ...INSTALLED.imports, [file]: ["KERNEL32.dll"] } });
      assert.equal(result.ok, false, file);
      assert.match(result.message, new RegExp(`${file.replace(".", "\\.")} is part of a GPU runtime`));
    }
  });

  test("the app still may not import a GPU driver", () => {
    const result = checkDictationPackage("windows-x64", { ...INSTALLED, imports: { ...INSTALLED.imports, "oxide-app.exe": ["KERNEL32.dll", "vulkan-1.dll"] } });
    assert.equal(result.ok, false);
    assert.match(result.message, /oxide-app\.exe imports vulkan-1\.dll/);
  });
});

describe("runtime packages", () => {
  const VERSION = "0.4.0";
  const sha = (character) => character.repeat(64);
  const vulkan = () => {
    const hashes = { "oxide-vulkan-worker.exe": sha("a"), "vcruntime140.dll": sha("b"), "LICENSE-whisper.txt": sha("c"), "LICENSE-msvc-runtime.txt": sha("d") };
    return {
      manifest: runtimePackageManifest({ backend: "vulkan", version: VERSION, hashes }),
      files: [...Object.keys(hashes), "manifest.json"],
      hashes,
      imports: { "oxide-vulkan-worker.exe": ["vulkan-1.dll", "KERNEL32.dll", "VCRUNTIME140.dll"], "vcruntime140.dll": ["KERNEL32.dll"] },
    };
  };
  const cuda = () => {
    const names = ["oxide-cuda-worker.exe", ...CUDA_RUNTIME, "vcruntime140.dll", "LICENSE-whisper.txt", "LICENSE-cuda.txt", "LICENSE-msvc-runtime.txt"];
    const hashes = Object.fromEntries(names.map((name, index) => [name, sha(String(index))]));
    return {
      manifest: runtimePackageManifest({ backend: "cuda", version: VERSION, hashes }),
      files: [...names, "manifest.json"],
      hashes,
      imports: {
        "oxide-cuda-worker.exe": ["cudart64_12.dll", "cublas64_12.dll", "KERNEL32.dll", "VCRUNTIME140.dll"],
        "cudart64_12.dll": ["KERNEL32.dll"], "cublas64_12.dll": ["cublasLt64_12.dll", "KERNEL32.dll"], "cublasLt64_12.dll": ["KERNEL32.dll"],
        "vcruntime140.dll": ["KERNEL32.dll"],
      },
    };
  };

  test("the manifest names the backend, version, protocol, worker and every file's hash, sorted", () => {
    const { manifest } = vulkan();
    assert.deepEqual(Object.keys(manifest), ["backend", "version", "protocolVersion", "worker", "files"]);
    assert.equal(manifest.protocolVersion, 1);
    assert.equal(manifest.worker, "oxide-vulkan-worker.exe");
    assert.deepEqual(Object.keys(manifest.files), ["LICENSE-msvc-runtime.txt", "LICENSE-whisper.txt", "oxide-vulkan-worker.exe", "vcruntime140.dll"]);
    assert.throws(() => runtimePackageManifest({ backend: "metal", version: VERSION, hashes: {} }), /backend/);
  });

  test("assets are named after backend, platform and version", () => {
    assert.equal(runtimeAssetName("cuda", "0.4.0"), "oxide-runtime-cuda-windows-x64-0.4.0.zip");
    assert.throws(() => runtimeAssetName("cuda", "../0.4"), /version/);
  });

  test("complete Vulkan and CUDA packages pass", () => {
    for (const [backend, build] of [["vulkan", vulkan], ["cuda", cuda]]) {
      const result = checkRuntimePackage(backend, build());
      assert.equal(result.ok, true, result.message);
    }
  });

  test("a missing worker, licence, CUDA DLL or manifest fails and names it", () => {
    const package_ = cuda();
    for (const file of ["oxide-cuda-worker.exe", "LICENSE-cuda.txt", "cublasLt64_12.dll", "manifest.json"]) {
      const result = checkRuntimePackage("cuda", { ...package_, files: package_.files.filter((name) => name !== file) });
      assert.equal(result.ok, false, file);
      assert.match(result.message, new RegExp(`${file.replace(".", "\\.")} is missing`));
    }
  });

  test("a file the manifest does not list, or lists with another hash, fails", () => {
    const package_ = vulkan();
    const extra = checkRuntimePackage("vulkan", { ...package_, files: [...package_.files, "extra.dll"], imports: { ...package_.imports, "extra.dll": [] } });
    assert.match(extra.message, /extra\.dll is not listed in manifest\.json/);
    const changed = checkRuntimePackage("vulkan", { ...package_, hashes: { ...package_.hashes, "vcruntime140.dll": sha("f") } });
    assert.match(changed.message, /vcruntime140\.dll differs from manifest\.json/);
  });

  test("the manifest must match the backend, the protocol and the worker", () => {
    const package_ = vulkan();
    assert.match(checkRuntimePackage("cuda", package_).message, /backend/);
    assert.match(checkRuntimePackage("vulkan", { ...package_, manifest: { ...package_.manifest, protocolVersion: 2 } }).message, /protocol 2, expected 1/);
    assert.match(checkRuntimePackage("vulkan", { ...package_, manifest: { ...package_.manifest, worker: "other.exe" } }).message, /worker/);
    assert.match(checkRuntimePackage("vulkan", { ...package_, manifest: undefined }).message, /manifest\.json is missing or unreadable/);
  });

  test("a bundled driver or an unresolved import fails, as in the installer", () => {
    const package_ = vulkan();
    const withDriver = checkRuntimePackage("vulkan", { ...package_, files: [...package_.files, "vulkan-1.dll"], imports: { ...package_.imports, "vulkan-1.dll": [] } });
    assert.match(withDriver.message, /vulkan-1\.dll is a graphics driver/);
    const lost = checkRuntimePackage("vulkan", { ...package_, files: package_.files.filter((name) => name !== "vcruntime140.dll") });
    assert.match(lost.message, /imports vcruntime140\.dll, the Visual C\+\+ runtime/);
  });

  test("a package may not hold folders", () => {
    const package_ = vulkan();
    assert.match(checkRuntimePackage("vulkan", { ...package_, files: [...package_.files, "sub/x.dll"] }).message, /sub\/x\.dll is not a flat file/);
  });
});

describe("CI lanes", () => {
  test("changing the runtime release tool runs the bundle lane, which builds and packages the workers", () => {
    const lanes = lanesFor(["tools/dictation-runtimes.mjs"], "pull_request");
    assert.equal(lanes.bundle, true);
    assert.equal(lanes.automation, true);
    assert.equal(lanes.rust, false);
  });
});

describe("runtimeIndex", () => {
  const packages = [{ backend: "vulkan", bytes: 10, sha256: "a".repeat(64) }, { backend: "cuda", bytes: 20, sha256: "b".repeat(64) }];
  const options = { repository: "cavallinilorenzo/oxide", tag: "v0.4.0" };

  test("lists each package with the release asset URL the app downloads, the size and the hash", () => {
    const index = runtimeIndex(packages, options);
    assert.equal(index.version, 1);
    assert.deepEqual(index.runtimes.map(({ backend }) => backend), ["cuda", "vulkan"]);
    assert.deepEqual(index.runtimes[0], {
      backend: "cuda", version: "0.4.0", protocolVersion: 1, platform: "windows-x86_64",
      url: "https://github.com/cavallinilorenzo/oxide/releases/download/v0.4.0/oxide-runtime-cuda-windows-x64-0.4.0.zip",
      bytes: 20, sha256: "b".repeat(64), requirements: "an NVIDIA driver for CUDA 12.9 and compute capability 5.0 or later",
    });
    assert.match(index.runtimes[1].requirements, /Vulkan 1\.2/);
  });

  test("the platform and protocol are the ones the core compares against", () => {
    assert.ok(rustSource.includes('format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)'));
    assert.equal(RUNTIME_PLATFORM, "windows-x86_64");
    assert.match(rustSource, new RegExp(`PROTOCOL_VERSION: u32 = ${RUNTIME_PROTOCOL};`));
  });

  test("a missing backend, a bad hash or size, or a bad tag is refused", () => {
    assert.throws(() => runtimeIndex(packages.slice(0, 1), options), /cuda/);
    assert.throws(() => runtimeIndex([{ ...packages[0], sha256: "xyz" }, packages[1]], options), /SHA-256/);
    assert.throws(() => runtimeIndex([{ ...packages[0], bytes: 0 }, packages[1]], options), /size/);
    assert.throws(() => runtimeIndex(packages, { ...options, tag: "main" }), /tag/);
    assert.throws(() => runtimeIndex(packages, { ...options, repository: "no slash" }), /repository/);
  });

  test("the app reads the index of the latest release, and carries the public key in its source", () => {
    assert.ok(rustSource.replace(/\s+/g, " ").includes(`RUNTIME_INDEX_URL: &str = "${runtimeIndexUrl("cavallinilorenzo/oxide")}"`));
    assert.match(rustSource, /RUNTIME_PUBLIC_KEY: &str = "[A-Za-z0-9+/=]{56}"/);
  });
});
