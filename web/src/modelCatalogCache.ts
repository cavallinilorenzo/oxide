import { commands, type ModelInfo } from "./bindings";

export const PICKER_PROVIDERS = ["claude", "codex", "antigravity"] as const;

/** Last known catalog per Provider, shared by the Model picker and the Favourite shortcut. */
export const catalogCache = new Map<string, ModelInfo[]>();

/** Which Providers are installed, once detected. Absent until the first detection finishes. */
export const installedCache = new Map<string, boolean>();

let detection: Promise<void> | null = null;

export function resetCatalogCache() {
  catalogCache.clear();
  installedCache.clear();
  detection = null;
}

/** Detects every Provider once; later calls share the same result instead of spawning the CLIs again. */
export function detectProviders(): Promise<void> {
  detection ??= Promise.all(
    PICKER_PROVIDERS.map(async (id) => {
      try {
        const result = await commands.detectProvider(id);
        installedCache.set(id, result.status === "ok" && result.data.installed);
      } catch {
        installedCache.set(id, false);
      }
    })
  ).then(() => undefined);
  return detection;
}

/** Fetches a Provider's catalog: the stored one first, then a refresh, keeping the cached list if the refresh fails. */
export async function loadCatalog(
  provider: string,
  onUpdate: (list: ModelInfo[]) => void = () => {}
): Promise<void> {
  const apply = (list: ModelInfo[]) => {
    catalogCache.set(provider, list);
    onUpdate(list);
  };
  try {
    if (!catalogCache.has(provider)) {
      const stored = await commands.getModelCatalog(provider, false);
      if (stored.status === "ok") apply(stored.data);
    }
    const fresh = await commands.getModelCatalog(provider, true);
    if (fresh.status === "ok" && fresh.data.length > 0) apply(fresh.data);
  } catch {
    // A failed refresh leaves the cached catalog available.
  }
}

/** Run at launch so the Model picker opens with Providers and catalogs already known. */
export async function warmModelCatalogs(): Promise<void> {
  await detectProviders();
  await Promise.all(PICKER_PROVIDERS.filter((p) => installedCache.get(p)).map((p) => loadCatalog(p)));
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
