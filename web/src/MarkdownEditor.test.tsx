// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor label="Comment" value={value} onChange={setValue} />;
}

const area = () => host.querySelector("textarea") as HTMLTextAreaElement;
const tool = (name: string) => host.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;

it("offers Write and Preview tabs and the formatting toolbar", async () => {
  await act(async () => root.render(<Harness initial="" />));
  expect(host.querySelector('[role="tablist"]')).not.toBeNull();
  for (const name of ["Heading", "Bold", "Italic", "Quote", "Code", "Link", "Bulleted list", "Numbered list", "Task list"]) {
    expect(tool(name)).not.toBeNull();
  }
});

it("formats the selected text from the toolbar", async () => {
  await act(async () => root.render(<Harness initial="hello world" />));
  area().setSelectionRange(0, 5);
  await act(async () => tool("Bold").click());
  expect(area().value).toBe("**hello** world");
});

it("hides the toolbar while previewing", async () => {
  await act(async () => root.render(<Harness initial="x" />));
  const preview = [...host.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Preview") as HTMLElement;
  await act(async () => preview.click());
  expect(host.querySelector('[role="toolbar"]')).toBeNull();
});
