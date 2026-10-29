import assert from "node:assert/strict";
import { test } from "node:test";
import { dictationBuild } from "../dictation-build.mjs";

test("CPU and Vulkan builds isolate inherited Cargo and CMake state", () => {
  const inherited = {
    PATH: "tools", CARGO_TARGET_DIR: "custom-target",
    CMAKE_GENERATOR: "Visual Studio 18 2026",
    CMAKE_GENERATOR_INSTANCE: "old-vs", CMAKE_GENERATOR_PLATFORM: "x64",
    CMAKE_GENERATOR_TOOLSET: "old-toolset", CMAKE_TOOLCHAIN_FILE: "old.cmake",
    GGML_VULKAN: "ON", GGML_CUDA: "ON", GGML_METAL: "ON", GGML_HIP: "ON",
  };
  const cpu = dictationBuild("cpu", inherited);
  const vulkan = dictationBuild("vulkan", inherited);
  assert.notEqual(cpu.env.CARGO_TARGET_DIR, vulkan.env.CARGO_TARGET_DIR);
  for (const build of [cpu, vulkan]) {
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
  assert.ok(vulkan.args.includes("dictation-vulkan"));
  assert.equal(inherited.CMAKE_GENERATOR_INSTANCE, "old-vs");
});

test("unknown backends cannot accidentally produce a CPU build", () => {
  assert.throws(() => dictationBuild("cuda", {}), /Expected backend: cpu or vulkan/);
  assert.throws(() => dictationBuild(undefined, {}), /Expected backend: cpu or vulkan/);
});
