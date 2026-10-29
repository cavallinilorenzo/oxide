// Run from an x64 Native Tools command prompt (or Developer PowerShell).
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBuildSpace } from "./checks/build-space.mjs";

export function dictationBuild(backend, inherited = process.env) {
  if (!["cpu", "vulkan"].includes(backend)) {
    throw new Error("Expected backend: cpu or vulkan");
  }
  // whisper-rs-sys forwards CMAKE_* variables into its nested shader build.
  // In particular, a VS instance is invalid with the Ninja generator. Start
  // both CMake invocations from the same explicit, MSVC/Ninja environment.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.toUpperCase().startsWith("CMAKE_") &&
    !["CC", "CXX", "CARGO_TARGET_DIR", "GGML_VULKAN", "GGML_CUDA", "GGML_METAL", "GGML_HIP"].includes(key.toUpperCase())));
  Object.assign(env, {
    CMAKE_GENERATOR: "Ninja", CC: "cl.exe", CXX: "cl.exe",
    CMAKE_C_COMPILER: "cl.exe", CMAKE_CXX_COMPILER: "cl.exe",
    // Nested shader-generator TryCompile paths approach MSVC's 260-character
    // object/PDB limit even in an ordinary checkout. Keep these names short.
    CARGO_TARGET_DIR: resolve(join(inherited.CARGO_TARGET_DIR || "target", backend === "cpu" ? "dc" : "dv")),
  });
  return {
    env,
    args: ["build", "--locked", "-p", "oxide-app",
      ...(backend === "vulkan" ? ["--features", "dictation-vulkan"] : [])],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "win32") throw new Error("This build entry point requires Windows x64");
    const build = dictationBuild(process.argv[2]);
    for (const command of ["cl.exe", "cmake.exe", "ninja.exe", ...(process.argv[2] === "vulkan" ? ["glslc.exe"] : [])]) {
      if (spawnSync("where.exe", [command], { env: build.env }).status !== 0) {
        throw new Error(`Missing ${command}: use an x64 Native Tools prompt; see docs/dictation.md`);
      }
    }
    assertBuildSpace(process.cwd());
    const result = spawnSync("cargo", build.args, { env: build.env, stdio: "inherit" });
    if (result.error) throw result.error;
    assertBuildSpace(process.cwd());
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
