// Run from an x64 Native Tools command prompt (or Developer PowerShell).
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync } from "node:fs";
import { assertBuildSpace } from "./checks/build-space.mjs";
import { msvcEnv } from "./checks/msvc-env.mjs";

export function dictationBuild(backend, inherited = process.env) {
  if (!["cpu", "vulkan", "cuda"].includes(backend)) {
    throw new Error("Expected backend: cpu, vulkan or cuda");
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
    CARGO_TARGET_DIR: resolve(join(inherited.CARGO_TARGET_DIR || "target", backend === "cpu" ? "dc" : (backend === "cuda" ? "dcu" : "dv"))),
  });
  return {
    env,
    args: ["build", "--locked", "-p", "oxide-app",
      ...(backend === "vulkan" ? ["--features", "dictation-vulkan"] : []),
      ...(backend === "cuda" ? ["--features", "dictation-cuda"] : [])],
    ...(backend === "vulkan" ? { worker: {
      args: ["build", "--locked", "--manifest-path", "crates/oxide-vulkan-worker/Cargo.toml"],
      env: { ...env, CARGO_TARGET_DIR: resolve(join(inherited.CARGO_TARGET_DIR || "target", "vw")) },
    } } : {}),
    ...(backend === "cuda" ? { worker: {
      args: ["build", "--locked", "--manifest-path", "crates/oxide-cuda-worker/Cargo.toml"],
      env: { ...env, CARGO_TARGET_DIR: resolve(join(inherited.CARGO_TARGET_DIR || "target", "cw")) },
    } } : {}),
  };
}

/**
 * The release build of a GPU worker for packaging. ggml otherwise tunes code to
 * the build machine (GGML_NATIVE): AVX-512 on a CI runner, or only the CUDA
 * architectures it can see. OFF selects its portable x64 baseline (AVX2, FMA,
 * F16C) and CUDA architecture list (5.0 to Blackwell on CUDA 12).
 */
export function releaseWorker(backend, inherited = process.env) {
  if (!["vulkan", "cuda"].includes(backend)) throw new Error("Expected worker backend: vulkan or cuda");
  const { worker } = dictationBuild(backend, inherited);
  const name = `oxide-${backend}-worker`;
  return {
    args: ["build", "--locked", "--release", "--manifest-path", `crates/${name}/Cargo.toml`],
    env: { ...worker.env, GGML_NATIVE: "OFF" },
    exe: join(worker.env.CARGO_TARGET_DIR, "release", `${name}.exe`),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "win32") throw new Error("This build entry point requires Windows x64");
    const build = dictationBuild(process.argv[2], process.argv[2] === "cuda" ? msvcEnv() : process.env);
    for (const command of ["cl.exe", "cmake.exe", "ninja.exe", ...(process.argv[2] === "vulkan" ? ["glslc.exe"] : []), ...(process.argv[2] === "cuda" ? ["nvcc.exe"] : [])]) {
      if (spawnSync("where.exe", [command], { env: build.env }).status !== 0) {
        throw new Error(`Missing ${command}: use an x64 Native Tools prompt; see docs/dictation.md`);
      }
    }
    assertBuildSpace(process.cwd());
    const result = spawnSync("cargo", build.args, { env: build.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status === 0 && build.worker) {
      assertBuildSpace(process.cwd());
      const worker = spawnSync("cargo", build.worker.args, { env: build.worker.env, stdio: "inherit" });
      if (worker.error) throw worker.error;
      if (worker.status !== 0) process.exit(worker.status ?? 1);
      const workerName = process.argv[2] === "cuda" ? "oxide-cuda-worker.exe" : "oxide-vulkan-worker.exe";
      copyFileSync(join(build.worker.env.CARGO_TARGET_DIR, "debug", workerName),
        join(build.env.CARGO_TARGET_DIR, "debug", workerName));
    }
    assertBuildSpace(process.cwd());
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
