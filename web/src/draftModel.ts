type DraftModel = { provider: string; model: string | null; effort: string | null };
type DraftStorage = Pick<Storage, "getItem" | "setItem">;
const key = (projectId: number) => `oxide:draft-model:${projectId}`;

export function loadDraftModel(storage: DraftStorage, projectId: number): DraftModel | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key(projectId)) ?? "null");
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.provider !== "string" ||
        !(candidate.model === null || typeof candidate.model === "string") ||
        !(candidate.effort === null || typeof candidate.effort === "string")) return null;
    return { provider: candidate.provider, model: candidate.model, effort: candidate.effort };
  } catch { return null; }
}

export function saveDraftModel(storage: DraftStorage, projectId: number, value: DraftModel): void {
  try { storage.setItem(key(projectId), JSON.stringify(value)); } catch { /* The draft remains usable without storage. */ }
}
