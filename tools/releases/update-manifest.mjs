// Build the signed static feed consumed by the native Tauri updater.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function updateManifest(directory, { repository, tag, date = new Date().toISOString() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Invalid release identity.");
  const platforms = {};
  for (const [target, pattern] of [["darwin-aarch64", /\.app\.tar\.gz$/], ["windows-x86_64", /_x64-setup\.exe$/]]) {
    const files = readdirSync(directory).filter((file) => pattern.test(file));
    if (files.length === 0) continue;
    if (files.length !== 1) throw new Error(`${target}: expected exactly one updater package.`);
    const file = files[0];
    const signaturePath = join(directory, `${file}.sig`);
    if (!existsSync(signaturePath)) throw new Error(`Missing signature for ${file}.`);
    const signature = readFileSync(signaturePath, "utf8").trim();
    if (!signature) throw new Error(`Empty signature for ${file}.`);
    platforms[target] = { signature, url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(file)}` };
  }
  if (!Object.keys(platforms).length) throw new Error("No supported updater packages found.");
  return { version: tag.slice(1), notes: `Oxide ${tag.slice(1)}\nRelease notes: https://github.com/${repository}/releases/tag/${tag}`, pub_date: date, platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] ?? "release-artifacts";
  writeFileSync(join(directory, "latest.json"), JSON.stringify(updateManifest(directory, { repository: process.argv[4] ?? "cavallinilorenzo/oxide", tag: process.argv[3] ?? "" }), null, 2) + "\n");
}
