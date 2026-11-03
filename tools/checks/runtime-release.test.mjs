import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateSigningKey, publicKeyOf, readZipFlat, signMinisign, verifyMinisign, zipFlat } from "./runtime-release.mjs";

test("a signature verifies with the matching public key only", () => {
  const key = generateSigningKey();
  const other = generateSigningKey();
  const data = Buffer.from('{"version":1}');
  const signature = signMinisign(key.secretKey, data, "oxide runtimes-index.json");
  assert.equal(publicKeyOf(key.secretKey), key.publicKey);
  assert.equal(verifyMinisign(key.publicKey, data, signature), true);
  assert.equal(verifyMinisign(other.publicKey, data, signature), false);
  assert.equal(verifyMinisign(key.publicKey, Buffer.from('{"version":2}'), signature), false);
});

test("the signature file follows the minisign layout", () => {
  const { secretKey } = generateSigningKey();
  const lines = signMinisign(secretKey, Buffer.from("x"), "hello").trimEnd().split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^untrusted comment: /);
  assert.equal(Buffer.from(lines[1], "base64").length, 74);
  assert.equal(Buffer.from(lines[1], "base64").subarray(0, 2).toString(), "ED");
  assert.match(lines[2], /^trusted comment: /);
  assert.equal(Buffer.from(lines[3], "base64").length, 64);
});

test("a tampered trusted comment is refused", () => {
  const { secretKey, publicKey } = generateSigningKey();
  const signature = signMinisign(secretKey, Buffer.from("x"), "hello");
  assert.equal(verifyMinisign(publicKey, Buffer.from("x"), signature.replace("trusted comment: hello", "trusted comment: evil")), false);
});

test("a malformed secret key or signature is an error, not a pass", () => {
  assert.throws(() => signMinisign("not-a-key", Buffer.from("x"), "c"), /signing key/);
  assert.equal(verifyMinisign(generateSigningKey().publicKey, Buffer.from("x"), "garbage"), false);
});

test("the flat zip round-trips its files and is reproducible", () => {
  const files = [["manifest.json", Buffer.from("{}")], ["worker.exe", Buffer.alloc(100_000, 7)], ["empty.txt", Buffer.alloc(0)]];
  const entries = Object.fromEntries(readZipFlat(zipFlat(files)));
  assert.deepEqual(Object.keys(entries), ["empty.txt", "manifest.json", "worker.exe"]);
  for (const [name, body] of files) assert.deepEqual(entries[name], body);
  const digest = (zip) => createHash("sha256").update(zip).digest("hex");
  assert.equal(digest(zipFlat(files)), digest(zipFlat([...files].reverse())));
});

test("reading refuses a corrupted file and something that is not a zip", () => {
  const stored = zipFlat([["a.txt", Buffer.from("abc")]]);
  stored[35] ^= 0xff; // the first content byte
  assert.throws(() => readZipFlat(stored), /CRC/);
  assert.throws(() => readZipFlat(Buffer.from("not a zip")), /not a zip/i);
});

test("reading refuses a folder entry", () => {
  const zip = zipFlat([["a.txt", Buffer.from("abc")]]);
  // Rename the entry in both headers to "a/b.t" (same length), as a hostile archive might.
  for (let at = zip.indexOf("a.txt"); at >= 0; at = zip.indexOf("a.txt", at + 1)) zip.write("a/b.t", at);
  assert.throws(() => readZipFlat(zip), /flat/);
});

test("a zip refuses paths with folders or traversal", () => {
  for (const name of ["a/b.txt", "..\\x", "../x", "", "/abs"]) assert.throws(() => zipFlat([[name, Buffer.from("x")]]), /flat/);
});
