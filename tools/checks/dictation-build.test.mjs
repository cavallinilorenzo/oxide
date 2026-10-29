import assert from "node:assert/strict";
import { test } from "node:test";
import { dictationBuild } from "../dictation-build.mjs";

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
