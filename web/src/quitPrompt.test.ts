import { describe, expect, it } from "vitest";
import { quitPrompt } from "./quitPrompt";

describe("quitPrompt", () => {
  it("names how many Threads quitting interrupts", () => {
    expect(quitPrompt(1)).toBe("Quit and interrupt 1 Thread?");
    expect(quitPrompt(3)).toBe("Quit and interrupt 3 Threads?");
  });
});
