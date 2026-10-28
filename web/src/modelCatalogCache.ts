import { commands, type ModelInfo } from "./bindings";

/** Last known catalog per Provider, shared by the Model picker and the Favourite shortcut. */
export const catalogCache = new Map<string, ModelInfo[]>();

export function resetCatalogCache() {
  catalogCache.clear();
}

/** The cached catalog of every given Provider, fetching (without refresh) the ones not cached yet. */
export async function cachedCatalogs(providers: string[]): Promise<Record<string, ModelInfo[]>> {
  await Promise.all(
    providers
      .filter((p) => !catalogCache.has(p))
      .map(async (p) => {
        const res = await commands.getModelCatalog(p, false);
        if (res.status === "ok") catalogCache.set(p, res.data);
      })
  );
  return Object.fromEntries(providers.flatMap((p) => (catalogCache.has(p) ? [[p, catalogCache.get(p)!]] : [])));
}
