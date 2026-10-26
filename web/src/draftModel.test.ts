import { expect, it } from "vitest";
import { loadDraftModel, saveDraftModel } from "./draftModel";

it("restores the chosen provider, model and effort for a project's draft", () => {
  const storage = new Map<string, string>();
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
  saveDraftModel(store, 1, { provider: "codex", model: "chosen", effort: "high" });
  expect(loadDraftModel(store, 1)).toEqual({ provider: "codex", model: "chosen", effort: "high" });
  expect(loadDraftModel(store, 2)).toBeNull();
});
