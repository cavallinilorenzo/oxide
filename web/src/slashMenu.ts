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
 * Whether the command needs an argument before it can run. `[model]`, `<model>?` and empty
 * brackets are optional; anything else (e.g. `<instructions>`) is required.
 */
export function slashArgumentRequired(argumentHint: string | null | undefined): boolean {
  const hint = argumentHint?.trim();
  if (!hint) return false;
  if (hint.endsWith("?")) return false;
  if (/^\[[^\]]*\]$/.test(hint)) return false;
  if (/^\{[^}]*\}$/.test(hint)) return false;
  return true;
}

/** Whether the typed `/word` already names `command` (or one of its aliases). */
function namesCommand(command: SlashCommand, typed: string): boolean {
  const word = typed.trim().replace(/^\//, "").toLowerCase();
  return [command.name, ...(command.aliases ?? [])].some((name) => name.toLowerCase() === word);
}

/**
 * What picking `command` from the menu does. A command that requires an argument is completed to
 * `/name ` so the argument can follow; Tab does the same for any command. Enter on one whose
 * argument is absent or optional runs it once its name (or alias) is typed, else completes the name.
 *
 * Oxide routes always handle an empty argument themselves (`/model` opens the picker, `/rename`
 * starts renaming, `/permissions` opens its menu), so their catalog hint never forces a second
 * Enter. Only passthrough/native commands may genuinely need one.
 */
export function pickSlashCommand(
  command: SlashCommand,
  key: "Enter" | "Tab",
  typed: string,
): { insert: string } | { submit: true } {
  const needsArgument = command.route !== "oxide" && slashArgumentRequired(command.argumentHint);
  if (key === "Tab" || needsArgument) return { insert: `/${command.name} ` };
  return namesCommand(command, typed) ? { submit: true } : { insert: `/${command.name}` };
}
