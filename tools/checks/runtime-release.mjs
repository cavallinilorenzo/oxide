// Signing and packaging primitives for the downloadable dictation runtimes, with no
// dependency beyond Node: the release runners need neither a minisign binary nor a zip tool.
//
// Signatures are minisign's prehashed format ("ED": Ed25519 over BLAKE2b-512), so
// `minisign -V` and the app's `minisign-verify` accept them. The secret key CI keeps is
// base64(keynum[8] || ed25519 seed[32]); the public key is minisign's usual base64
// ("Ed" || keynum || public key). Generate a pair with `node tools/dictation-runtimes.mjs keygen`.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const privateKeyOf = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
const publicBytes = (seed) => createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);

function parseSecret(secretKey) {
  const bytes = Buffer.from(String(secretKey).trim(), "base64");
  if (bytes.length !== 40) throw new Error("The runtime signing key is not valid: expected base64 of 40 bytes (key id and seed).");
  return { keynum: bytes.subarray(0, 8), seed: bytes.subarray(8) };
}

export function generateSigningKey() {
  const seed = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length);
  const secretKey = Buffer.concat([randomBytes(8), seed]).toString("base64");
  return { secretKey, publicKey: publicKeyOf(secretKey) };
}

export function publicKeyOf(secretKey) {
  const { keynum, seed } = parseSecret(secretKey);
  return Buffer.concat([Buffer.from("Ed"), keynum, publicBytes(seed)]).toString("base64");
}

const blake2b = (data) => createHash("blake2b512").update(data).digest();

/** A minisign signature file for `data`. The trusted comment is covered by the signature. */
export function signMinisign(secretKey, data, trustedComment) {
  const { keynum, seed } = parseSecret(secretKey);
  const key = privateKeyOf(seed);
  const signature = sign(null, blake2b(data), key);
  const trusted = Buffer.from(trustedComment);
  const global = sign(null, Buffer.concat([signature, trusted]), key);
  return [
    "untrusted comment: signature from oxide runtime release key",
    Buffer.concat([Buffer.from("ED"), keynum, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

/** Whether `signatureFile` is a valid minisign signature of `data` by `publicKey`. */
export function verifyMinisign(publicKey, data, signatureFile) {
  try {
    const pk = Buffer.from(publicKey, "base64");
    const lines = String(signatureFile).split(/\r?\n/);
    const body = Buffer.from(lines[1] ?? "", "base64");
    const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
    const global = Buffer.from(lines[3] ?? "", "base64");
    if (pk.length !== 42 || body.length !== 74 || global.length !== 64 || !(lines[2] ?? "").startsWith("trusted comment: ")) return false;
    if (body.subarray(0, 2).toString() !== "ED" || !body.subarray(2, 10).equals(pk.subarray(2, 10))) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk.subarray(10)]), format: "der", type: "spki" });
    const signature = body.subarray(10);
    return verify(null, blake2b(data), key, signature) && verify(null, Buffer.concat([signature, Buffer.from(trusted)]), key, global);
  } catch {
    return false;
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2020-01-01 00:00:00 in DOS time: the same bytes on every build.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/**
 * A flat, reproducible zip of `[name, Buffer]` pairs, sorted by name. Folders and
 * `..` are refused: the app accepts a flat layout only.
 */
export function zipFlat(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!name || /[\\/]/.test(name) || name === "..") throw new Error(`"${name}" is not a flat file name: a runtime package is a flat folder.`);
    const raw = Buffer.from(name);
    const deflated = deflateRawSync(content, { level: 9 });
    const stored = deflated.length >= content.length;
    const body = stored ? content : deflated;
    const crc = crc32(content);
    const common = Buffer.alloc(26);
    common.writeUInt16LE(20, 0); // version needed
    common.writeUInt16LE(0x0800, 2); // UTF-8 names
    common.writeUInt16LE(stored ? 0 : 8, 4);
    common.writeUInt16LE(DOS_TIME, 6);
    common.writeUInt16LE(DOS_DATE, 8);
    common.writeUInt32LE(crc, 10);
    common.writeUInt32LE(body.length, 14);
    common.writeUInt32LE(content.length, 18);
    common.writeUInt16LE(raw.length, 22);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), common, raw, body]);
    const entry = Buffer.alloc(42);
    entry.writeUInt16LE(20, 0); // version made by
    common.copy(entry, 2, 0, 26);
    entry.writeUInt32LE(0, 30); // external attributes
    entry.writeUInt32LE(offset, 38);
    central.push(Buffer.concat([Buffer.from([0x50, 0x4b, 1, 2]), entry, raw]));
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The files of a flat zip as `[name, Buffer]` pairs, checked against their CRC-32. */
export function readZipFlat(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (end < 0) throw new Error("Not a zip archive: no central directory.");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("Corrupt zip: bad central directory entry.");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const length = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
    if (!name || /[\\/]/.test(name) || name === "..") throw new Error(`"${name}" is not a flat file name: a runtime package is a flat folder.`);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`Corrupt zip: unsupported compression for ${name}.`);
    const content = method === 8 ? inflateRawSync(body) : body;
    if (content.length !== length || crc32(content) !== crc) throw new Error(`Corrupt zip: CRC mismatch in ${name}.`);
    files.push([name, content]);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}
