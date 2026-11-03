// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { CommandOutcome, ItemSnapshot } from "./bindings";
import { ActivityView } from "./ActivityView";
import { buildActivity } from "./activity";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => act(async () => root.render(null)));

let nextId = 1;
const commandItem = (
  itemIndex: number,
  line: string,
  outcome: CommandOutcome,
): ItemSnapshot => ({
  id: nextId++,
  itemIndex,
  kind: "tool_call",
  content: `Run ${line}\noutput`,
  parentItemIndex: null,
  category: "run",
  command: { line, outcome, exitCode: outcome === "failed" ? 1 : 0 },
  createdAt: "2026-10-22T10:00:00Z",
});

const activityOf = (items: ItemSnapshot[]) => buildActivity(items, new Map());

async function render(items: ItemSnapshot[], workedMs: number | null = null) {
  await act(async () =>
    root.render(
      <ActivityView
        activity={activityOf(items)}
        live={null}
        waiting={false}
        startedAt="2026-10-22T10:00:00Z"
        workedMs={workedMs}
      />,
    ),
  );
}

const byText = (selector: string, text: string) =>
  [...container.querySelectorAll<HTMLElement>(selector)].find((el) =>
    el.textContent?.includes(text),
  );
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};

it("marks a failed command on the collapsed Activity and on its collapsed Phase", async () => {
  await render([
    commandItem(0, "cargo test", "succeeded"),
    commandItem(1, "cargo clippy", "failed"),
  ]);

  const summary = byText("button.activity-summary-toggle", "Ran 2 commands");
  expect(summary?.getAttribute("aria-expanded")).toBe("false");
  const summaryMark = summary?.querySelector(".activity-failed");
  expect(summaryMark?.getAttribute("aria-label")).toBe("1 failed command");
  expect(summaryMark?.textContent).toContain("Failed");

  await click(summary);
  const phase = byText("button.activity-phase-toggle", "Ran");
  expect(phase?.getAttribute("aria-expanded")).toBe("false");
  const phaseMark = phase?.querySelector(".activity-failed");
  expect(phaseMark?.getAttribute("aria-label")).toBe("1 failed command");

  await click(phase);
  const failedItem = byText("button.activity-item", "Run cargo clippy");
  expect(failedItem?.classList.contains("activity-item-failed")).toBe(true);
  expect(failedItem?.querySelector(".activity-failed")?.getAttribute("aria-label")).toBe(
    "1 failed command",
  );
  const succeededItem = byText("button.activity-item", "Run cargo test");
  expect(succeededItem?.classList.contains("activity-item-failed")).toBe(false);
  expect(succeededItem?.querySelector(".activity-failed")).toBeNull();
});

it("does not mark a command whose outcome is unknown", async () => {
  await render([commandItem(0, "cargo fmt", "unknown")]);
  expect(container.querySelector(".activity-failed")).toBeNull();
  expect(container.querySelector(".activity-item-failed")).toBeNull();
});
