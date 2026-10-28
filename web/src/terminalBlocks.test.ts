import { expect, it } from "vitest";
import { BlockParser, commandSuggestions } from "./terminalBlocks";

it("preserves output and boundaries at every UTF-8 and marker split", () => {
  const wire = new TextEncoder().encode(
    "boot\x1b]633;Oxide;abc;start\x07caffè\r\n\x1b]633;Oxide;abc;end;7;C:\\code;folder\x07\x1b]633;Oxide;closed\x07",
  );
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new TextDecoder();
    const parser = new BlockParser();
    const events = [
      ...parser.push(decoder.decode(wire.slice(0, split), { stream: true })),
      ...parser.push(decoder.decode(wire.slice(split))),
    ];
    expect(
      events
        .filter((e) => e.type === "output")
        .map((e) => e.text)
        .join(""),
    ).toBe("bootcaffè\r\n");
    expect(events.filter((e) => e.type !== "output")).toEqual([
      { type: "start", token: "abc" },
      { type: "end", token: "abc", exitCode: 7, cwd: "C:\\code;folder" },
      { type: "closed" },
    ]);
  }
});
it("keeps non-Oxide ANSI sequences for the terminal emulator", () => {
  expect(new BlockParser().push("\x1b[6n\x1b[31mred\x1b[0m")).toEqual([
    { type: "output", text: "\x1b[6n\x1b[31mred\x1b[0m" },
  ]);
});
it("offers deduplicated history matches without executing or changing input", () => {
  const history = [
    { command: "git status", at: 1, exitCode: 0 },
    { command: "git diff --stat", at: 2, exitCode: 0 },
    { command: "git status", at: 3, exitCode: 0 },
  ];
  expect(commandSuggestions("git s", history)).toEqual(["git status"]);
  expect(commandSuggestions("git d", history)[0]).toBe("git diff --stat");
  expect(commandSuggestions("git status", history)).not.toContain("git status");
  expect(commandSuggestions("echo first\necho second", history)).toEqual([]);
});
