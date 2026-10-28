export type BlockEvent =
  | { type: "output"; text: string }
  | { type: "start"; token: string }
  | { type: "end"; token: string; exitCode: number; cwd: string }
  | { type: "closed" };
const PREFIX = "\x1b]633;Oxide;";

/** OSC markers may be split anywhere, including inside the prefix or across UTF-8 chunks. */
export class BlockParser {
  private pending = "";
  push(text: string): BlockEvent[] {
    this.pending += text;
    const events: BlockEvent[] = [];
    while (this.pending) {
      const start = this.pending.indexOf(PREFIX);
      if (start < 0) {
        let keep = 0;
        for (let n = 1; n < PREFIX.length; n++)
          if (this.pending.endsWith(PREFIX.slice(0, n))) keep = n;
        const output = this.pending.slice(0, this.pending.length - keep);
        if (output) events.push({ type: "output", text: output });
        this.pending = keep ? this.pending.slice(-keep) : "";
        break;
      }
      if (start > 0) {
        events.push({ type: "output", text: this.pending.slice(0, start) });
        this.pending = this.pending.slice(start);
      }
      const end = this.pending.indexOf("\x07", PREFIX.length);
      if (end < 0) {
        if (this.pending.length > 8192) {
          events.push({ type: "output", text: this.pending });
          this.pending = "";
        }
        break;
      }
      const parts = this.pending.slice(PREFIX.length, end).split(";");
      this.pending = this.pending.slice(end + 1);
      if (parts[0] === "closed") events.push({ type: "closed" });
      else if (parts[1] === "start")
        events.push({ type: "start", token: parts[0]! });
      else if (parts[1] === "end" && /^-?\d+$/.test(parts[2] ?? ""))
        events.push({
          type: "end",
          token: parts[0]!,
          exitCode: Number(parts[2]),
          cwd: parts.slice(3).join(";"),
        });
    }
    return events;
  }
}

export type CommandHistory = {
  command: string;
  at: number;
  exitCode: number | null;
};
export function commandSuggestions(
  input: string,
  history: CommandHistory[],
): string[] {
  const prefix = input.trimStart();
  if (!prefix || prefix.includes("\n")) return [];
  const builtins = [
    "git status",
    "git diff",
    "git log --oneline -10",
    "git branch",
    "git fetch",
    "pwd",
    "ls",
    "python --version",
    "node --version",
    "cargo test",
    "npm test",
  ];
  return [
    ...new Set(
      [...history]
        .reverse()
        .map((h) => h.command)
        .concat(builtins),
    ),
  ]
    .filter((command) => command.startsWith(prefix) && command !== input)
    .slice(0, 5);
}
