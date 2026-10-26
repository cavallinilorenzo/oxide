import type { SlashCommand } from "./bindings";

/** The `/` menu is open while the composer holds a single `/word` with no space yet. */
export function slashQuery(input: string): string | null {
  const m = /^\/([^\s/]*)$/.exec(input);
  return m ? m[1] : null;
}

/**
 * Commands whose name or alias starts with the query first, then those that merely contain it.
 * Each command keeps one row, however many of its names match.
 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const starts = commands.filter((c) => names(c).some((n) => n.startsWith(q)));
  const contains = commands.filter(
    (c) => !names(c).some((n) => n.startsWith(q)) && names(c).some((n) => n.includes(q)),
  );
  return [...starts, ...contains];
}

/**
 * What picking `command` from the menu does. A command that takes an argument is completed to
 * `/name ` so the argument can follow; Tab does the same for any command. Enter on one that takes
 * none runs it, completing the name first when only a prefix or alias was typed.
 */
export function pickSlashCommand(
  command: SlashCommand,
  key: "Enter" | "Tab",
  typed: string,
): { insert: string } | { submit: true } {
  const takesArgument = !!command.argumentHint;
  if (key === "Tab" || takesArgument) return { insert: `/${command.name} ` };
  return typed === `/${command.name}` ? { submit: true } : { insert: `/${command.name}` };
}
