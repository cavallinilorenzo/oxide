import { describe, expect, it } from "vitest";
import { canSubmitComment, canSubmitIssue, formatIssueLabel } from "./issueView";

describe("issueView", () => {
  it("formats issue labels with number and title", () => {
    expect(formatIssueLabel({ number: 42, title: "Crash on startup" })).toBe("#42 Crash on startup");
  });

  it("validates issue creation title", () => {
    expect(canSubmitIssue("")).toBe(false);
    expect(canSubmitIssue("   ")).toBe(false);
    expect(canSubmitIssue("Valid title")).toBe(true);
  });

  it("validates comment body", () => {
    expect(canSubmitComment("")).toBe(false);
    expect(canSubmitComment("   ")).toBe(false);
    expect(canSubmitComment("Looks good")).toBe(true);
  });
});
