/** Windows extended filesystem paths belong to native APIs, not to a shell prompt. */
export function terminalPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
