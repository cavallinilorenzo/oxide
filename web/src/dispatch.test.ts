import { describe, expect, it } from "vitest";
import type { Settings } from "./bindings";
import { defaultDispatchForm, dispatchRequest, isBoardThread, withProvider } from "./dispatch";

const settings = {
  defaultProvider: "claude",
  providers: {
    claude: { model: "opus", effort: "high", permissionMode: "ask" },
    codex: { model: null, effort: null, permissionMode: "full-access" },
    antigravity: { model: null, effort: null, permissionMode: "auto-edit" },
  },
} as unknown as Settings;

describe("dispatch form", () => {
  it("is prefilled with the default Provider's settings and the checked-out branch", () => {
    expect(defaultDispatchForm(settings, "main")).toEqual({
      prompt: "",
      provider: "claude",
      model: "opus",
      effort: "high",
      permissionMode: "ask",
      baseBranch: "main",
    });
  });

  it("takes the other Provider's defaults when the Provider changes, keeping prompt and branch", () => {
    const form = { ...defaultDispatchForm(settings, "dev"), prompt: "Fix it" };
    expect(withProvider(form, settings, "codex")).toEqual({
      prompt: "Fix it",
      provider: "codex",
      model: "",
      effort: "",
      permissionMode: "full-access",
      baseBranch: "dev",
    });
  });

  it("sends blank optional fields as null and trims the prompt", () => {
    const form = { ...defaultDispatchForm(settings, ""), prompt: "  Fix it \n", model: " ", effort: "low" };
    expect(dispatchRequest(7, form)).toEqual({
      projectId: 7,
      prompt: "Fix it",
      provider: "claude",
      model: null,
      effort: "low",
      permissionMode: "ask",
      baseBranch: null,
    });
  });

  it("tells Board Threads from chat Threads by their branch", () => {
    expect(isBoardThread({ branch: "oxide/x" })).toBe(true);
    expect(isBoardThread({ branch: null })).toBe(false);
  });
});
