// @vitest-environment jsdom
import { expect, it } from "vitest";
import { formatDuration } from "./TerminalCommandBlock";

it.each([
  [0, "0 ms"],
  [17, "17 ms"],
  [999, "999 ms"],
  [999.6, "1.00 s"],
  [1_000, "1.00 s"],
  [1_240, "1.24 s"],
  [59_990, "59.99 s"],
  [59_999, "1m 0.0s"],
  [60_000, "1m 0.0s"],
  [123_400, "2m 3.4s"],
  [119_960, "2m 0.0s"],
])("formats %d ms as %s", (milliseconds, text) => {
  expect(formatDuration(milliseconds)).toBe(text);
});
