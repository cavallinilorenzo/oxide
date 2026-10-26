// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ResizeHandle } from "./ResizeHandle";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));

function press(key: string, shiftKey = false) {
  act(() => container.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true })));
}

it("announces bounds and supports keyboard movement, limits and reset", () => {
  const commit = vi.fn();
  function Panel() {
    const [value, setValue] = useState(240);
    return <ResizeHandle label="Resize sidebar" controls="sidebar" axis="x" edge="end"
      value={value} min={208} max={400} onResize={setValue} onCommit={commit} onCancel={() => {}} onReset={() => setValue(240)} />;
  }
  act(() => root.render(<Panel />));
  const separator = container.querySelector("[role=separator]")!;
  expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  expect(separator.getAttribute("aria-valuetext")).toBe("240 pixels");
  press("ArrowRight");
  expect(commit).toHaveBeenLastCalledWith(248);
  press("ArrowLeft", true);
  expect(commit).toHaveBeenLastCalledWith(216);
  press("Home");
  press("ArrowLeft");
  expect(commit).toHaveBeenLastCalledWith(208);
  press("End");
  press("ArrowRight");
  expect(commit).toHaveBeenLastCalledWith(400);
  press("Enter");
  expect(separator.getAttribute("aria-valuenow")).toBe("240");
});

it("moves a bottom panel upward to increase its height and ignores unrelated arrows", () => {
  const commit = vi.fn();
  act(() => root.render(<ResizeHandle label="Resize Terminal" controls="terminal" axis="y" edge="start" direction={-1}
    value={200} min={140} max={400} onResize={() => {}} onCommit={commit} onCancel={() => {}} onReset={() => {}} />));
  expect(container.querySelector("[role=separator]")?.getAttribute("aria-orientation")).toBe("horizontal");
  press("ArrowLeft");
  expect(commit).not.toHaveBeenCalled();
  press("ArrowUp");
  expect(commit).toHaveBeenLastCalledWith(208);
  press("ArrowDown", true);
  expect(commit).toHaveBeenLastCalledWith(168);
});
