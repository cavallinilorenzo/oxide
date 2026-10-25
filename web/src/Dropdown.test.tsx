// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));

it("opens on the selected option and commits keyboard selection", () => {
  const onChange = vi.fn();
  act(() => root.render(<Dropdown label="Provider" value="claude" options={[
    { value: "claude", label: "Claude" }, { value: "codex", label: "Codex" },
  ]} onChange={onChange} />));
  const trigger = container.querySelector("button")!;
  expect(trigger.getAttribute("aria-label")).toBe("Provider: Claude");
  act(() => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Claude");
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement?.textContent).toBe("Codex");
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onChange).toHaveBeenCalledWith("codex");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(trigger);
});

it("cancels with Escape and closes when focus leaves without changing the value", () => {
  const onChange = vi.fn();
  act(() => root.render(<Dropdown label="Effort" value="" options={[
    { value: "", label: "Provider default" }, { value: "high", label: "High" },
  ]} onChange={onChange} />));
  const trigger = container.querySelector("button")!;
  act(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement?.textContent).toBe("High");
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.activeElement).toBe(trigger);
  expect(container.querySelector("[role=listbox]")).toBeNull();
  act(() => trigger.click());
  const outside = document.createElement("button");
  document.body.append(outside);
  act(() => outside.focus());
  expect(container.querySelector("[role=listbox]")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  outside.remove();
});

it("exposes the selected option and allows pointer selection and dismissal", () => {
  const onChange = vi.fn();
  act(() => root.render(<Dropdown label="Model" value="saved-model" options={[
    { value: "", label: "Provider default" }, { value: "saved-model", label: "Saved model" },
  ]} onChange={onChange} />));
  const trigger = container.querySelector("button")!;
  act(() => trigger.click());
  expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("Saved model");
  act(() => container.querySelector<HTMLElement>('[role="option"]')!.click());
  expect(onChange).toHaveBeenCalledWith("");
  act(() => trigger.click());
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(container.querySelector("[role=listbox]")).toBeNull();
});

it("keeps the keyboard choice focused when options are refreshed", () => {
  const render = () => root.render(<Dropdown label="Provider" value="claude" options={[
    { value: "claude", label: "Claude" }, { value: "codex", label: "Codex" },
  ]} onChange={() => {}} />);
  act(render);
  act(() => container.querySelector("button")!.click());
  act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  act(render);
  expect(document.activeElement?.textContent).toBe("Codex");
});
