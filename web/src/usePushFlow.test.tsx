// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "./bindings";
import { usePushFlow } from "./usePushFlow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
});

it("reports a transport rejection after committing and exits the busy state without opening a PR", async () => {
  vi.spyOn(commands, "gitStatus").mockResolvedValue({
    status: "ok",
    data: {
      branch: "topic",
      upstream: "origin/topic",
      ahead: 0,
      behind: 0,
      added: 1,
      removed: 0,
      changedFiles: 1,
      protected: false,
      unpublished: false,
      pickerDisabledReason: null,
    },
  });
  const commit = vi.fn().mockResolvedValue({ status: "ok", data: null });
  const push = vi
    .spyOn(commands, "push")
    .mockRejectedValue(new Error("Connection lost"));
  const refreshed = vi.fn();
  const openPr = vi.fn();
  function Harness() {
    const flow = usePushFlow(1, 7, refreshed, openPr);
    return (
      <>
        <button disabled={flow.busy} onClick={() => void flow.start(commit)}>
          Commit &amp; Push
        </button>
        <p role="alert">{flow.error}</p>
      </>
    );
  }
  await act(async () => root.render(<Harness />));
  await act(async () => host.querySelector("button")!.click());
  expect(commit).toHaveBeenCalledOnce();
  expect(push).toHaveBeenCalledWith(1, 7, false);
  expect(host.textContent).toContain("Connection lost");
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(refreshed).toHaveBeenCalledOnce();
  expect(openPr).not.toHaveBeenCalled();
});
