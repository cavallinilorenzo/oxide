// The DLLs a Windows executable imports, read from its PE import directory.
// Pure JavaScript, so packaging checks need no dumpbin and run on any OS.

const IMPORT_DIRECTORY = 1;
const DESCRIPTOR_SIZE = 20;

/** Import DLL names in table order. Throws for anything that is not a PE image. */
export function peImports(image) {
  const read = (method, offset) => {
    if (offset < 0 || offset + { readUInt16LE: 2, readUInt32LE: 4 }[method] > image.length) {
      throw new Error("The executable is truncated.");
    }
    return image[method](offset);
  };
  if (image.length < 0x40 || image.toString("latin1", 0, 2) !== "MZ") throw new Error("This is not a Windows executable.");
  const header = read("readUInt32LE", 0x3c);
  if (header + 24 > image.length || image.toString("latin1", header, header + 4) !== "PE\0\0") {
    throw new Error("This is not a Windows executable.");
  }
  const sectionCount = read("readUInt16LE", header + 6);
  const optional = header + 24;
  const optionalSize = read("readUInt16LE", header + 20);
  const magic = read("readUInt16LE", optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error("This is not a Windows executable.");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (read("readUInt32LE", directories - 4) <= IMPORT_DIRECTORY) return [];
  const importRva = read("readUInt32LE", directories + IMPORT_DIRECTORY * 8);
  if (importRva === 0) return [];

  const sections = Array.from({ length: sectionCount }, (_, index) => {
    const at = optional + optionalSize + index * 40;
    return {
      address: read("readUInt32LE", at + 12),
      size: Math.max(read("readUInt32LE", at + 8), read("readUInt32LE", at + 16)),
      raw: read("readUInt32LE", at + 20),
    };
  });
  const offsetOf = (rva) => {
    const section = sections.find(({ address, size }) => rva >= address && rva < address + size);
    if (!section) throw new Error(`The executable is truncated: RVA 0x${rva.toString(16)} is in no section.`);
    return rva - section.address + section.raw;
  };
  const nameAt = (rva) => {
    const start = offsetOf(rva);
    const end = image.indexOf(0, start);
    if (end < 0) throw new Error("The executable is truncated.");
    return image.toString("latin1", start, end);
  };

  const dlls = [];
  for (let descriptor = offsetOf(importRva); ; descriptor += DESCRIPTOR_SIZE) {
    const name = read("readUInt32LE", descriptor + 12);
    const thunks = read("readUInt32LE", descriptor + 16);
    if (name === 0 && thunks === 0) return dlls;
    dlls.push(nameAt(name));
  }
}
