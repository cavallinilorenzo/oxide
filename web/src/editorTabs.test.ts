import { describe, expect, it } from "vitest";
import { batchCloseTargets, neighborAfterClose, previewToReplace } from "./editorTabs";

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
