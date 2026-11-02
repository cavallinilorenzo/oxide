import { describe, expect, it } from "vitest";
import { batchCloseTargets, neighborAfterClose, previewToReplace, rovingTab } from "./editorTabs";

describe("neighborAfterClose", () => {
  const order = ["a", "b", "c"];
  it("picks the tab to the right, else the left", () => {
    expect(neighborAfterClose(order, "b")).toBe("c");
    expect(neighborAfterClose(order, "c")).toBe("b");
  });
  it("leaves nothing active after the final close", () => {
    expect(neighborAfterClose(["a"], "a")).toBeNull();
  });
});

describe("previewToReplace", () => {
  it("replaces an unmodified preview", () => {
    expect(previewToReplace([{ path: "a", preview: true, dirty: false }, { path: "b", preview: false, dirty: false }])).toBe("a");
  });
  it("never replaces a dirty or kept file", () => {
    expect(previewToReplace([{ path: "a", preview: true, dirty: true }, { path: "b", preview: false, dirty: false }])).toBeNull();
  });
});

describe("batchCloseTargets", () => {
  const order = ["a", "b", "c"];
  it("closes all but the kept one, or everything", () => {
    expect(batchCloseTargets(order, "others", "b")).toEqual(["a", "c"]);
    expect(batchCloseTargets(order, "all", "b")).toEqual(["a", "b", "c"]);
  });
});

describe("rovingTab", () => {
  const tabs = ["a", "b", "c"];
  it("steps with arrows and wraps", () => {
    expect(rovingTab(tabs, "b", "ArrowRight")).toBe("c");
    expect(rovingTab(tabs, "c", "ArrowRight")).toBe("a");
    expect(rovingTab(tabs, "a", "ArrowLeft")).toBe("c");
    expect(rovingTab(tabs, "b", "ArrowLeft")).toBe("a");
  });
  it("jumps with Home and End", () => {
    expect(rovingTab(tabs, "b", "Home")).toBe("a");
    expect(rovingTab(tabs, "b", "End")).toBe("c");
  });
  it("handles empty or missing", () => {
    expect(rovingTab([], "a", "ArrowRight")).toBeNull();
    expect(rovingTab(tabs, "x", "ArrowRight")).toBe("a");
  });
});
