import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestProblems, runtimeFiles } from "../dictation-package.mjs";

const IMPORTS = {
  "C:/b/oxide-cuda-worker.exe": ["cudart64_12.dll", "cublas64_12.dll", "nvcuda.dll", "KERNEL32.dll", "MSVCP140.dll"],
  "C:/b/oxide-vulkan-worker.exe": ["vulkan-1.dll", "KERNEL32.dll", "VCRUNTIME140.dll"],
  "C:/cuda/bin/cudart64_12.dll": ["KERNEL32.dll"],
  "C:/cuda/bin/cublas64_12.dll": ["cublasLt64_12.dll", "KERNEL32.dll"],
  "C:/cuda/bin/cublasLt64_12.dll": ["KERNEL32.dll"],
  "C:/vc/msvcp140.dll": ["VCRUNTIME140.dll", "VCRUNTIME140_1.dll", "api-ms-win-crt-runtime-l1-1-0.dll"],
  "C:/vc/vcruntime140.dll": ["KERNEL32.dll"],
  "C:/vc/vcruntime140_1.dll": ["VCRUNTIME140.dll"],
};
const SOURCES = new Map([
  ["cudart64_12.dll", "C:/cuda/bin/cudart64_12.dll"], ["cublas64_12.dll", "C:/cuda/bin/cublas64_12.dll"],
  ["cublaslt64_12.dll", "C:/cuda/bin/cublasLt64_12.dll"], ["cufft64_11.dll", "C:/cuda/bin/cufft64_11.dll"],
  ["msvcp140.dll", "C:/vc/msvcp140.dll"], ["vcruntime140.dll", "C:/vc/vcruntime140.dll"],
  ["vcruntime140_1.dll", "C:/vc/vcruntime140_1.dll"],
]);
const importsOf = (path) => IMPORTS[path];

test("stages exactly the redistributable DLLs the workers load, following their own imports", () => {
  const staged = runtimeFiles(["C:/b/oxide-cuda-worker.exe", "C:/b/oxide-vulkan-worker.exe"], SOURCES, importsOf);
  assert.deepEqual(staged.map(({ from }) => from).sort(), [
    "C:/cuda/bin/cublas64_12.dll", "C:/cuda/bin/cublasLt64_12.dll", "C:/cuda/bin/cudart64_12.dll",
    "C:/vc/msvcp140.dll", "C:/vc/vcruntime140.dll", "C:/vc/vcruntime140_1.dll",
  ]);
  // The file name on disk is kept, not the import's spelling.
  assert.ok(staged.some(({ name }) => name === "cublasLt64_12.dll"));
});

test("drivers, system DLLs and unused runtime libraries are never staged", () => {
  const staged = runtimeFiles(["C:/b/oxide-vulkan-worker.exe"], SOURCES, importsOf).map(({ name }) => name);
  assert.deepEqual(staged, ["vcruntime140.dll"]);
});

test("the manifest catches a staged file that changed or disappeared before packaging", () => {
  const manifest = { files: [{ path: "oxide-cuda-worker.exe", sha256: "a".repeat(64) }, { path: "cudart64_12.dll", sha256: "b".repeat(64) }] };
  assert.deepEqual(manifestProblems(manifest, { "oxide-cuda-worker.exe": "a".repeat(64), "cudart64_12.dll": "b".repeat(64) }), []);
  assert.deepEqual(manifestProblems(manifest, { "oxide-cuda-worker.exe": "c".repeat(64) }), [
    "oxide-cuda-worker.exe differs from the staged build",
    "cudart64_12.dll is listed in dictation-runtime.json but missing",
  ]);
  assert.deepEqual(manifestProblems(undefined, {}), ["dictation-runtime.json is missing or unreadable"]);
});
