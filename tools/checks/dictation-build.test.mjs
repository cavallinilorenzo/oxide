import assert from "node:assert/strict";
import { test } from "node:test";
import { dictationBuild, releaseWorker } from "../dictation-build.mjs";

test("CPU, Vulkan and CUDA builds isolate inherited Cargo and CMake state", () => {
  const inherited = {
    PATH: "tools", CARGO_TARGET_DIR: "custom-target",
    CMAKE_GENERATOR: "Visual Studio 18 2026",
    CMAKE_GENERATOR_INSTANCE: "old-vs", CMAKE_GENERATOR_PLATFORM: "x64",
    CMAKE_GENERATOR_TOOLSET: "old-toolset", CMAKE_TOOLCHAIN_FILE: "old.cmake",
    GGML_VULKAN: "ON", GGML_CUDA: "ON", GGML_METAL: "ON", GGML_HIP: "ON",
  };
  const cpu = dictationBuild("cpu", inherited);
  const vulkan = dictationBuild("vulkan", inherited);
  const cuda = dictationBuild("cuda", inherited);
  assert.notEqual(cpu.env.CARGO_TARGET_DIR, vulkan.env.CARGO_TARGET_DIR);
  assert.notEqual(cpu.env.CARGO_TARGET_DIR, cuda.env.CARGO_TARGET_DIR);
  assert.notEqual(vulkan.env.CARGO_TARGET_DIR, cuda.env.CARGO_TARGET_DIR);
  for (const build of [cpu, vulkan, cuda]) {
    assert.equal(build.env.CMAKE_GENERATOR, "Ninja");
    assert.equal(build.env.CMAKE_GENERATOR_INSTANCE, undefined);
    assert.equal(build.env.CMAKE_GENERATOR_PLATFORM, undefined);
    assert.equal(build.env.CMAKE_GENERATOR_TOOLSET, undefined);
    assert.equal(build.env.CMAKE_TOOLCHAIN_FILE, undefined);
    for (const flag of ["GGML_VULKAN", "GGML_CUDA", "GGML_METAL", "GGML_HIP"]) {
      assert.equal(build.env[flag], undefined);
    }
    assert.equal(build.env.CC, "cl.exe");
    assert.equal(build.env.CXX, "cl.exe");
    assert.equal(build.env.PATH, "tools");
  }
  assert.ok(!cpu.args.includes("dictation-vulkan"));
  assert.ok(!cpu.args.includes("dictation-cuda"));
  assert.ok(vulkan.args.includes("dictation-vulkan"));
  assert.ok(!vulkan.args.includes("dictation-cuda"));
  assert.ok(cuda.args.includes("dictation-cuda"));
  assert.ok(!cuda.args.includes("dictation-vulkan"));
  assert.equal(inherited.CMAKE_GENERATOR_INSTANCE, "old-vs");
});

test("unknown backends cannot accidentally produce a CPU build", () => {
  assert.throws(() => dictationBuild("metal", {}), /Expected backend: cpu, vulkan or cuda/);
  assert.throws(() => dictationBuild(undefined, {}), /Expected backend: cpu, vulkan or cuda/);
});

test("Vulkan and CUDA build separate locked workers without sharing the host native cache", () => {
  const vulkan = dictationBuild("vulkan", { CARGO_TARGET_DIR: "short-root" });
  assert.deepEqual(vulkan.worker.args, ["build", "--locked", "--manifest-path", "crates/oxide-vulkan-worker/Cargo.toml"]);
  assert.notEqual(vulkan.worker.env.CARGO_TARGET_DIR, vulkan.env.CARGO_TARGET_DIR);

  const cuda = dictationBuild("cuda", { CARGO_TARGET_DIR: "short-root" });
  assert.deepEqual(cuda.worker.args, ["build", "--locked", "--manifest-path", "crates/oxide-cuda-worker/Cargo.toml"]);
  assert.notEqual(cuda.worker.env.CARGO_TARGET_DIR, cuda.env.CARGO_TARGET_DIR);

  assert.equal(dictationBuild("cpu", {}).worker, undefined);
});

test("builds preserve explicit nvcc flags without bypassing host compiler compatibility", () => {
  const inherited = { CARGO_TARGET_DIR: "short-root", NVCC_APPEND_FLAGS: "-lineinfo" };
  for (const env of [dictationBuild("cuda", inherited).env, dictationBuild("cuda", inherited).worker.env, releaseWorker("cuda", inherited).env]) {
    assert.equal(env.NVCC_APPEND_FLAGS, "-lineinfo");
  }
  assert.equal(dictationBuild("cuda", {}).env.NVCC_APPEND_FLAGS, undefined);
  assert.equal(dictationBuild("vulkan", inherited).env.NVCC_APPEND_FLAGS, "-lineinfo");
  assert.equal(dictationBuild("cpu", {}).env.NVCC_APPEND_FLAGS, undefined);
});

test("packaged workers are release builds tuned for any x64 CPU and CUDA GPU, not the build machine", () => {
  const inherited = { CARGO_TARGET_DIR: "short-root", CMAKE_GENERATOR_INSTANCE: "old-vs", GGML_NATIVE: "ON", GGML_CUDA: "ON" };
  for (const backend of ["vulkan", "cuda"]) {
    const worker = releaseWorker(backend, inherited);
    assert.deepEqual(worker.args, ["build", "--locked", "--release", ...(backend === "cuda" ? ["-vv"] : []), "--manifest-path", `crates/oxide-${backend}-worker/Cargo.toml`]);
    // GGML_NATIVE=OFF selects ggml's portable AVX2 baseline and its CUDA architecture list.
    assert.equal(worker.env.GGML_NATIVE, "OFF");
    assert.equal(worker.env.GGML_CUDA, undefined);
    assert.equal(worker.env.CMAKE_GENERATOR_INSTANCE, undefined);
    assert.equal(worker.env.CMAKE_GENERATOR, "Ninja");
    assert.equal(worker.env.CARGO_TARGET_DIR, dictationBuild(backend, inherited).worker.env.CARGO_TARGET_DIR);
    assert.match(worker.exe.replaceAll("\\", "/"), new RegExp(`/release/oxide-${backend}-worker\\.exe$`));
  }
  assert.throws(() => releaseWorker("cpu", {}), /vulkan or cuda/);
});
