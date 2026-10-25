import { describe, expect, it, vi } from "vitest";
import { performThreadDelete, selectionAfterDelete, threadsAfterDelete } from "./deleteThread";

describe("performThreadDelete", () => {
  it("deletes the persisted Thread after confirmation", async () => {
    const command = vi.fn().mockResolvedValue({ status: "ok", data: "deleted" });

    await expect(performThreadDelete(7, false, command)).resolves.toEqual({ status: "deleted" });
    expect(command).toHaveBeenCalledWith(7, false);
  });

  it("retries after the user confirms discarding worktree changes", async () => {
    const command = vi.fn()
      .mockResolvedValueOnce({ status: "ok", data: "needs-confirmation" })
      .mockResolvedValueOnce({ status: "ok", data: "deleted" });

    await expect(performThreadDelete(7, false, command)).resolves.toEqual({ status: "needs-confirmation" });
    await expect(performThreadDelete(7, true, command)).resolves.toEqual({ status: "deleted" });
    expect(command).toHaveBeenNthCalledWith(2, 7, true);
  });
});

describe("after deleting a Thread", () => {
  const threads = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("removes it from the sidebar list", () => {
    expect(threadsAfterDelete(threads, 2)).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it("clears the active Thread so the view falls back to a new Thread", () => {
    expect(selectionAfterDelete(2, 2)).toBeNull();
  });

  it("keeps the active Thread when another Thread is deleted", () => {
    expect(selectionAfterDelete(1, 2)).toBe(1);
  });
});
