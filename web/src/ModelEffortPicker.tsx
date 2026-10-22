import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commands, type ModelInfo } from "./bindings";
import { ProviderMark } from "./ProviderMark";
import { applyModelShortcut, filterModels } from "./modelPicker";

const PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "antigravity", name: "Antigravity" },
] as const;

export interface ModelEffortPickerProps {
  open: boolean;
  onClose: () => void;
  currentProvider: string;
  currentModel: string | null;
  currentEffort: string | null;
  turnCount: number;
  midThreadModelSwitch: boolean;
  onSelectModelAndEffort: (
    provider: string,
    model: string | null,
    effort: string | null
  ) => void;
  initialMode?: "model" | "effort";
}

export function ModelEffortPicker({
  open,
  onClose,
  currentProvider,
  currentModel,
  currentEffort,
  turnCount,
  midThreadModelSwitch,
  onSelectModelAndEffort,
  initialMode = "model",
}: ModelEffortPickerProps) {
  const [activeTab, setActiveTab] = useState<string>(currentProvider);
  const [search, setSearch] = useState("");
  const [favourites, setFavourites] = useState<string[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(currentEffort);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const providerLocked = turnCount > 0;
  const modelSwitchLocked = turnCount > 0 && !midThreadModelSwitch;

  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus();
    }
  }, [open]);

  // Load favourites and refresh catalogs
  useEffect(() => {
    if (!open) return;
    let active = true;

    async function load() {
      setLoading(true);
      try {
        const favRes = await commands.getFavouriteModels();
        if (active && favRes.status === "ok") {
          setFavourites(favRes.data);
        }

        const providersToFetch = [
          "claude",
          "codex",
          "antigravity",
          ...(currentProvider === "fake" ? ["fake"] : []),
        ];

        const results = await Promise.all(
          providersToFetch.map(async (p) => {
            const res = await commands.getModelCatalog(p, true);
            return [p, res.status === "ok" ? res.data : []] as const;
          })
        );

        if (active) {
          const map: Record<string, ModelInfo[]> = {};
          for (const [p, list] of results) {
            map[p] = list;
          }
          setCatalogs(map);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [open, currentProvider]);

  const toggleFavourite = async (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = favourites.includes(modelId)
      ? favourites.filter((id) => id !== modelId)
      : [...favourites, modelId];
    setFavourites(next);
    await commands.setFavouriteModels(next);
  };

  // Determine models for the current tab
  const tabModels = useMemo(() => {
    if (activeTab === "favourites") {
      const allModels = Object.values(catalogs).flat();
      const unique = new Map<string, ModelInfo>();
      for (const m of allModels) {
        if (favourites.includes(m.id) && !unique.has(m.id)) {
          unique.set(m.id, m);
        }
      }
      return Array.from(unique.values());
    }
    return catalogs[activeTab] || [];
  }, [activeTab, catalogs, favourites]);

  const { current: visibleCurrent, legacy: visibleLegacy } = useMemo(
    () => filterModels(tabModels, search),
    [tabModels, search]
  );

  const flatVisible = useMemo(
    () => [...visibleCurrent, ...visibleLegacy],
    [visibleCurrent, visibleLegacy]
  );

  // Active model info to show supported efforts
  const activeModelInfo = useMemo(() => {
    const all = Object.values(catalogs).flat();
    return all.find((m) => m.id === (currentModel || tabModels[0]?.id)) || tabModels[0];
  }, [catalogs, currentModel, tabModels]);

  const handleSelectModel = useCallback(
    (model: ModelInfo, isLocked: boolean) => {
      if (isLocked) return;
      const providerForModel =
        activeTab === "favourites"
          ? (Object.entries(catalogs).find(([, list]) =>
              list.some((m) => m.id === model.id)
            )?.[0] ?? currentProvider)
          : activeTab;

      const effortToUse = model.supportedEfforts.includes(selectedEffort || "")
        ? selectedEffort
        : model.defaultEffort ?? (model.supportedEfforts[0] || null);

      onSelectModelAndEffort(providerForModel, model.id, effortToUse);
      onClose();
    },
    [
      activeTab,
      catalogs,
      currentProvider,
      selectedEffort,
      onSelectModelAndEffort,
      onClose,
    ]
  );

  const handleSelectEffort = (effort: string) => {
    setSelectedEffort(effort);
    onSelectModelAndEffort(currentProvider, currentModel, effort);
    if (initialMode === "effort") {
      onClose();
    }
  };

  // Keyboard shortcut listener: ⌘1-9 and Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const index = parseInt(e.key, 10);
        const target = applyModelShortcut(index, flatVisible);
        if (target) {
          const isOtherProvider = activeTab !== currentProvider && activeTab !== "favourites";
          const isLocked = (providerLocked && isOtherProvider) || modelSwitchLocked;
          handleSelectModel(target, isLocked);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    open,
    flatVisible,
    activeTab,
    currentProvider,
    providerLocked,
    modelSwitchLocked,
    handleSelectModel,
    onClose,
  ]);

  if (!open) return null;

  const isOtherProvider = activeTab !== currentProvider && activeTab !== "favourites";
  const tabIsLocked = providerLocked && isOtherProvider;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Model and Effort Selector">
      <div className="modal model-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header">
          <h2>Model &amp; Effort</h2>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {/* Effort Section (shown when model supports effort) */}
        {activeModelInfo && activeModelInfo.supportedEfforts.length > 0 && (
          <div className="effort-selector-section">
            <span className="effort-label">Reasoning Effort:</span>
            <div className="effort-pills">
              {activeModelInfo.supportedEfforts.map((eff) => (
                <button
                  key={eff}
                  type="button"
                  className={`effort-pill ${selectedEffort === eff ? "selected" : ""}`}
                  onClick={() => handleSelectEffort(eff)}
                >
                  {eff.charAt(0).toUpperCase() + eff.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="model-picker-layout">
          {/* Provider Rail */}
          <nav className="provider-rail" aria-label="Provider rail">
            <button
              type="button"
              className={`rail-tab ${activeTab === "favourites" ? "active" : ""}`}
              onClick={() => setActiveTab("favourites")}
            >
              <span className="rail-icon">⭐</span>
              <span className="rail-text">Favourites</span>
            </button>

            {PROVIDERS.map((p) => {
              const isLocked = providerLocked && p.id !== currentProvider;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`rail-tab ${activeTab === p.id ? "active" : ""} ${
                    isLocked ? "locked" : ""
                  }`}
                  onClick={() => setActiveTab(p.id)}
                  title={isLocked ? "Provider locked after first turn" : undefined}
                >
                  <ProviderMark provider={p.id} size={14} />
                  <span className="rail-text">{p.name}</span>
                  {isLocked && <span className="lock-icon" aria-label="Locked">🔒</span>}
                </button>
              );
            })}

            {currentProvider === "fake" && (
              <button
                type="button"
                className={`rail-tab ${activeTab === "fake" ? "active" : ""}`}
                onClick={() => setActiveTab("fake")}
              >
                <span className="rail-text">Fake</span>
              </button>
            )}
          </nav>

          {/* Model Catalog / Search */}
          <div className="model-catalog-pane">
            <div className="model-search-wrapper">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search models..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="model-search-input"
                aria-label="Search models"
              />
            </div>

            {tabIsLocked && (
              <div className="tab-locked-banner" role="status">
                🔒 Provider locked after the first Turn. Models from other Providers cannot be selected.
              </div>
            )}

            {modelSwitchLocked && !tabIsLocked && (
              <div className="tab-locked-banner" role="status">
                🔒 Provider does not support mid-thread model switching.
              </div>
            )}

            <div className="models-list-scroll">
              {loading && <div className="models-loading">Loading catalog...</div>}

              {!loading && flatVisible.length === 0 && (
                <div className="models-empty">No models found.</div>
              )}

              {/* Active models section */}
              {visibleCurrent.length > 0 && (
                <div className="models-group">
                  <div className="models-group-title">Models</div>
                  {visibleCurrent.map((m, idx) => {
                    const isSelected = m.id === currentModel;
                    const isFav = favourites.includes(m.id);
                    const isItemLocked = tabIsLocked || (modelSwitchLocked && !isSelected);
                    const shortcutNumber = idx + 1 <= 9 ? idx + 1 : null;

                    return (
                      <div
                        key={m.id}
                        className={`model-row ${isSelected ? "selected" : ""} ${
                          isItemLocked ? "locked" : ""
                        }`}
                        onClick={() => handleSelectModel(m, isItemLocked)}
                        role="button"
                        tabIndex={0}
                        aria-disabled={isItemLocked}
                      >
                        <button
                          type="button"
                          className="fav-toggle-btn"
                          onClick={(e) => void toggleFavourite(m.id, e)}
                          aria-label={isFav ? "Unfavourite" : "Favourite"}
                        >
                          {isFav ? "★" : "☆"}
                        </button>

                        <div className="model-details">
                          <div className="model-name-row">
                            <span className="model-name">{m.name}</span>
                            {isSelected && <span className="current-badge">Active</span>}
                            {isItemLocked && <span className="locked-badge">🔒 Locked</span>}
                          </div>
                          {m.description && <div className="model-desc">{m.description}</div>}
                        </div>

                        {shortcutNumber && (
                          <span className="model-shortcut" title={`⌘${shortcutNumber}`}>
                            ⌘{shortcutNumber}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Legacy models section */}
              {visibleLegacy.length > 0 && (
                <div className="models-group legacy-group">
                  <div className="models-group-title">Legacy Models</div>
                  {visibleLegacy.map((m, idx) => {
                    const isSelected = m.id === currentModel;
                    const isFav = favourites.includes(m.id);
                    const isItemLocked = tabIsLocked || (modelSwitchLocked && !isSelected);
                    const overallIndex = visibleCurrent.length + idx + 1;
                    const shortcutNumber = overallIndex <= 9 ? overallIndex : null;

                    return (
                      <div
                        key={m.id}
                        className={`model-row legacy-row ${isSelected ? "selected" : ""} ${
                          isItemLocked ? "locked" : ""
                        }`}
                        onClick={() => handleSelectModel(m, isItemLocked)}
                        role="button"
                        tabIndex={0}
                        aria-disabled={isItemLocked}
                      >
                        <button
                          type="button"
                          className="fav-toggle-btn"
                          onClick={(e) => void toggleFavourite(m.id, e)}
                          aria-label={isFav ? "Unfavourite" : "Favourite"}
                        >
                          {isFav ? "★" : "☆"}
                        </button>

                        <div className="model-details">
                          <div className="model-name-row">
                            <span className="model-name">{m.name}</span>
                            {isSelected && <span className="current-badge">Active</span>}
                            {isItemLocked && <span className="locked-badge">🔒 Locked</span>}
                          </div>
                          {m.description && <div className="model-desc">{m.description}</div>}
                        </div>

                        {shortcutNumber && (
                          <span className="model-shortcut" title={`⌘${shortcutNumber}`}>
                            ⌘{shortcutNumber}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
