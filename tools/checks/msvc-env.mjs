import { spawnSync } from "node:child_process";
import { join } from "node:path";

// CUDA 12.9's frontend crashes with MSVC 14.51 even when its version guard is
// bypassed. The Windows runner also ships the VS 2022 toolset side by side.
// https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-VS2026-Readme.md
const TOOLSET = "14.44";
const matchesToolset = (env) => env.VCToolsVersion?.startsWith(`${TOOLSET}.`) && env.VCToolsRedistDir;

/** Merge cmd.exe's `set` output using Windows' case-insensitive variable names. */
export function withVcvars(base, setOutput) {
  const set = Object.fromEntries(setOutput.split(/\r?\n/).map((line) => line.match(/^([^=]+)=(.*)$/)).filter(Boolean).map(([, key, value]) => [key, value]));
  const replaced = new Set(Object.keys(set).map((key) => key.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(base).filter(([key]) => !replaced.has(key.toLowerCase()))), ...set };
}

// Load the pinned x64 native toolchain in a child process.
export function msvcEnv(env = process.env, run = spawnSync) {
  if (matchesToolset(env)) return env;
  const vswhere = join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const found = run(vswhere, [
    "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-find", "VC\\Auxiliary\\Build\\vcvars64.bat",
  ], { encoding: "utf8" });
  const vcvars = found.stdout?.split(/\r?\n/).find(Boolean);
  if (found.status !== 0 || !vcvars) {
    throw new Error(`Visual Studio Build Tools with MSVC ${TOOLSET} x64 tools were not found: see docs/dictation.md#packaging-and-distribution`);
  }
  const result = run(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${vcvars}" -vcvars_ver=${TOOLSET} >nul && set"`], {
    encoding: "utf8", env, windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cannot load MSVC ${TOOLSET}: ${result.stderr || result.stdout || result.error}. Install the ${TOOLSET} x64 toolset in Visual Studio Installer.`);
  const loaded = withVcvars(env, result.stdout);
  if (!matchesToolset(loaded)) {
    throw new Error(`Expected MSVC ${TOOLSET}, got ${loaded.VCToolsVersion ?? "no toolset"}. Install the ${TOOLSET} x64 toolset in Visual Studio Installer.`);
  }
  return loaded;
}
