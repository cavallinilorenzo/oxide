import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeFiles, withVcvars } from "../dictation-package.mjs";

test("the MSVC environment from vcvars replaces variables whatever their case, and keeps the rest", () => {
  const base = { PATH: "C:\\Windows", CUDA_PATH: "C:\\cuda", Lib: "old" };
  const set = "Path=C:\\VS\\bin;C:\\Windows\r\nLIB=C:\\VS\\lib\r\nVCToolsRedistDir=C:\\VS\\Redist\\\r\nCMAKE_ARGS=-DX=1\r\n\r\n";
  assert.deepEqual(withVcvars(base, set), {
    CUDA_PATH: "C:\\cuda",
    Path: "C:\\VS\\bin;C:\\Windows",
    LIB: "C:\\VS\\lib",
    VCToolsRedistDir: "C:\\VS\\Redist\\",
    CMAKE_ARGS: "-DX=1",
  });
});

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
