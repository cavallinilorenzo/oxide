import type { SlashCommand } from "./bindings";

/** The `/` menu is open while the composer holds a single `/word` with no space yet. */
export function slashQuery(input: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(input);
  return m ? m[1] : null;
}

/** Commands whose name starts with the query first, then those that merely contain it. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter(
    (c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}
