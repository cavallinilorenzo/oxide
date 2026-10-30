import assert from "node:assert/strict";
import { test } from "node:test";
import { peImports } from "./pe-imports.mjs";

// A minimal Windows executable: one section holding the import directory.
function executable(dlls, { pe32 = false } = {}) {
  const image = Buffer.alloc(0x400);
  image.write("MZ", 0);
  image.writeUInt32LE(0x40, 0x3c);
  image.write("PE\0\0", 0x40);
  const optionalSize = pe32 ? 224 : 240;
  image.writeUInt16LE(pe32 ? 0x14c : 0x8664, 0x44);
  image.writeUInt16LE(1, 0x46);
  image.writeUInt16LE(optionalSize, 0x54);
  const optional = 0x58;
  image.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional);
  const directories = optional + (pe32 ? 96 : 112);
  image.writeUInt32LE(16, directories - 4);
  image.writeUInt32LE(0x1000, directories + 8); // import directory RVA
  image.writeUInt32LE(20 * (dlls.length + 1), directories + 12);
  const section = optional + optionalSize;
  image.write(".idata", section);
  image.writeUInt32LE(0x200, section + 8);
  image.writeUInt32LE(0x1000, section + 12);
  image.writeUInt32LE(0x200, section + 16);
  image.writeUInt32LE(0x200, section + 20);
  let name = 0x1100;
  dlls.forEach((dll, index) => {
    image.writeUInt32LE(name, 0x200 + index * 20 + 12);
    image.writeUInt32LE(0x1180, 0x200 + index * 20 + 16);
    image.write(`${dll}\0`, 0x200 + name - 0x1000);
    name += dll.length + 1;
  });
  return image;
}

test("reads the DLLs a 64-bit executable imports, in order", () => {
  assert.deepEqual(peImports(executable(["KERNEL32.dll", "cudart64_12.dll", "nvcuda.dll"])), ["KERNEL32.dll", "cudart64_12.dll", "nvcuda.dll"]);
});

test("reads a 32-bit executable too, such as the NSIS uninstaller", () => {
  assert.deepEqual(peImports(executable(["KERNEL32.dll", "SHELL32.dll"], { pe32: true })), ["KERNEL32.dll", "SHELL32.dll"]);
});

test("an executable without imports has none", () => {
  assert.deepEqual(peImports(executable([])), []);
});

test("a file that is not a Windows executable is refused instead of read as having no imports", () => {
  assert.throws(() => peImports(Buffer.from("#!/bin/sh\necho not a PE\n")), /not a Windows executable/);
  const truncated = executable(["KERNEL32.dll"]).subarray(0, 0x60);
  assert.throws(() => peImports(truncated), /not a Windows executable|truncated/);
});
