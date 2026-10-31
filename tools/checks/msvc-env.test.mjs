import assert from "node:assert/strict";
import { test } from "node:test";
import { msvcEnv } from "./msvc-env.mjs";

const vcvars = "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat";
const compilerEnv = "VCToolsVersion=14.44.35207\r\nVCToolsRedistDir=C:\\VS\\Redist\\\r\nPath=C:\\VS\\14.44\\bin;C:\\Windows\r\n";

test("packaging switches the runner's inherited MSVC 14.51 environment to 14.44", () => {
  const calls = [];
  const inherited = {
    VCToolsVersion: "14.51.36231", VCToolsRedistDir: "C:\\VS\\14.51\\Redist\\",
    PATH: "C:\\VS\\14.51\\bin;C:\\Windows", CUDA_PATH: "C:\\cuda", ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  const env = msvcEnv(inherited, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: calls.length === 1 ? `${vcvars}\r\n` : compilerEnv };
  });
  assert.equal(env.VCToolsVersion, "14.44.35207");
  assert.equal(env.VCToolsRedistDir, "C:\\VS\\Redist\\");
  assert.equal(env.Path, "C:\\VS\\14.44\\bin;C:\\Windows");
  assert.equal(env.PATH, undefined);
  assert.equal(env.CUDA_PATH, inherited.CUDA_PATH);
  assert.equal(calls[1].command, inherited.ComSpec);
  assert.match(calls[1].args.at(-1), /\\vcvars64\.bat" -vcvars_ver=14\.44/);
  assert.equal(inherited.VCToolsVersion, "14.51.36231");
});

test("a fresh prompt explicitly selects 14.44 instead of Visual Studio's default", () => {
  const calls = [];
  const env = msvcEnv({}, (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: calls.length === 1 ? `${vcvars}\r\n` : compilerEnv };
  });
  assert.equal(env.VCToolsVersion, "14.44.35207");
  assert.match(calls[1].args.at(-1), /-vcvars_ver=14\.44/);
});

test("an initialized 14.44 prompt needs no discovery", () => {
  const env = { VCToolsVersion: "14.44.35207", VCToolsRedistDir: "C:\\VS\\Redist\\" };
  assert.equal(msvcEnv(env, () => assert.fail("already initialized")), env);
});

test("a missing pinned toolset fails with an actionable message", () => {
  let calls = 0;
  assert.throws(() => msvcEnv({}, () => ++calls === 1
    ? { status: 0, stdout: vcvars }
    : { status: 1, stderr: "toolset not found" }), /MSVC 14\.44.*toolset not found/);
});

test("vcvars success is insufficient if it still selected the incompatible compiler", () => {
  let calls = 0;
  assert.throws(() => msvcEnv({}, () => ({ status: 0, stdout: ++calls === 1
    ? vcvars : "VCToolsVersion=14.51.36231\r\nVCToolsRedistDir=C:\\VS\\Redist\\\r\n" })), /MSVC 14\.44.*14\.51/);
});
