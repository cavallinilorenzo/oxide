// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ItemSnapshot } from "./bindings";
import { DiffOpenContext } from "./diffOpen";
import type { TranscriptTurn } from "./transcript";
import { TurnView } from "./TurnView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => act(async () => root.render(null)));

let nextId = 1;
const item = (
  itemIndex: number,
  kind: ItemSnapshot["kind"],
  content: string,
  category: ItemSnapshot["category"] = null,
): ItemSnapshot => ({ id: nextId++, itemIndex, kind, content, parentItemIndex: null, category, createdAt: "2026-10-22T10:00:00Z" });

const turn = (over: Partial<TranscriptTurn>): TranscriptTurn => ({
  id: 1,
  turnIndex: 0,
  prompt: "do it",
  model: null,
  effort: null,
  segments: [],
  status: "completed",
  startedAt: "2026-10-22T10:00:00Z",
  completedAt: "2026-10-22T10:00:42Z",
  items: [],
  error: null,
  approvals: [],
  unknownEvents: [],
  ...over,
});

async function render(t: TranscriptTurn, openDiff = vi.fn()) {
  await act(async () =>
    root.render(
      <DiffOpenContext.Provider value={openDiff}>
        <TurnView turn={t} provider="claude" onRespond={vi.fn()} isWorking={t.status === "running"} instant />
      </DiffOpenContext.Provider>,
    ),
  );
  return openDiff;
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const buttonWith = (text: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const phase = (label: string) =>
  [...container.querySelectorAll<HTMLElement>(".activity-phase-toggle")].find((b) => b.textContent?.startsWith(label));

const worked = [
  item(0, "tool_call", "Read src/a.ts\nconst a = 1;", "explore"),
  item(1, "file_change", "src/a.ts"),
  item(2, "tool_call", "Run cargo test\n1 passed", "run"),
  item(3, "agent_message", "All done."),
];

it("ends collapsed on a summary with the time worked, the final message staying outside", async () => {
  await render(turn({ items: worked }));
  const summary = buttonWith("Explored 1 file · Edited 1 file · Ran 1 command");
  expect(summary?.getAttribute("aria-expanded")).toBe("false");
  expect(summary?.textContent).toContain("Worked for 42s");
  expect(container.textContent).toContain("All done.");
  expect(container.textContent).not.toContain("Pondering");
  expect(container.textContent).not.toContain("cargo test");
});

it("drills down from the summary to a phase to an Item's detail", async () => {
  await render(turn({ items: worked }));
  await click(buttonWith("Explored 1 file"));
  expect(phase("Ran")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("cargo test");

  await click(phase("Ran"));
  await click(buttonWith("Run cargo test"));
  expect(container.textContent).toContain("1 passed");
  // Other phases stay closed.
  expect(container.textContent).not.toContain("const a = 1;");
});

it("opens a file Item in the Diff Surface", async () => {
  const openDiff = await render(turn({ items: worked }));
  await click(buttonWith("Explored 1 file"));
  await click(phase("Edited"));
  await click(container.querySelector('[aria-label="Open diff for src/a.ts"]'));
  expect(openDiff).toHaveBeenCalledWith("src/a.ts");
});

it("shows a live line while running, ponders when idle, and drops it when the Turn ends", async () => {
  const running = turn({ status: "running", completedAt: null, startedAt: new Date().toISOString() });
  await render(running);
  expect(container.textContent).toContain("Pondering…");

  await render({ ...running, items: [item(0, "tool_call", "Run cargo test", "run")] });
  expect(container.textContent).not.toContain("Pondering");
  expect(container.querySelector(".activity-live-sub")?.textContent).toBe("Run cargo test");

  await render({ ...running, status: "completed", completedAt: new Date().toISOString(), items: [item(0, "tool_call", "Run cargo test", "run")] });
  expect(container.querySelector(".activity-live")).toBeNull();
  expect(buttonWith("Ran 1 command")).toBeTruthy();
});

it("shows no live line while waiting on an Approval", async () => {
  await render(
    turn({
      status: "running",
      completedAt: null,
      approvals: [{ id: 1, turnId: 1, approvalId: "a", kind: "command", summary: "rm", options: [], decision: null, createdAt: "", decidedAt: null }],
    }),
  );
  expect(container.querySelector(".activity-live-timer")).toBeNull();
  expect(container.textContent).toContain("Waiting for your approval");
});

it("renders no Activity for a Turn with no tool activity", async () => {
  await render(turn({ items: [item(0, "agent_message", "hello")] }));
  expect(container.querySelector(".activity")).toBeNull();
  expect(container.textContent).toContain("hello");
});

it("keeps the Activity open while new Items stream in", async () => {
  const running = turn({ status: "running", completedAt: null, startedAt: new Date().toISOString(), items: [worked[0]] });
  await render(running);
  await click(buttonWith("Explored 1 file"));
  await render({ ...running, items: [worked[0], worked[2]] });
  expect(buttonWith("Explored 1 file · Ran 1 command")?.getAttribute("aria-expanded")).toBe("true");
});


it("draws Attachments as chips between the words of the prompt, the same for every Provider", async () => {
  const attachment = (name: string, attachmentKind: "image" | "pdf" | "text" | "other") => ({
    kind: "attachment" as const, id: `id-${name}`, name, attachmentKind, mediaType: "x/y", sizeBytes: 2048, path: `/h/attachments/id-${name}/${name}`,
  });
  await render(turn({
    prompt: "Compare [a.png] with [spec.pdf]",
    segments: [
      { kind: "text", text: "Compare " }, attachment("a.png", "image"),
      { kind: "text", text: " with " }, attachment("spec.pdf", "pdf"),
    ],
  }));
  const bubble = container.querySelector(".user-bubble")!;
  const chips = Array.from(bubble.querySelectorAll('[role="img"]'));
  expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Attachment, a.png, image", "Attachment, spec.pdf, PDF"]);
  expect(chips[0].getAttribute("title")).toBe("a.png · 2.0 KB");
  expect(Array.from(bubble.childNodes).map((n) => n.textContent)).toEqual(["Compare ", "a.png", " with ", "spec.pdf"]);
  expect(bubble.querySelector("img.attachment-thumbnail")).not.toBeNull();
  expect(bubble.querySelector("button")).toBeNull();
});
