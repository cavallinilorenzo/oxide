import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LockIcon, StarFillIcon, StarIcon, XIcon } from "@primer/octicons-react";
import { commands, type ModelInfo } from "./bindings";
import { ProviderMark } from "./ProviderMark";
import { Dropdown } from "./Dropdown";
import {
  applyModelShortcut,
  collapseEffortVariants,
  filterModels,
  modelFamilyId,
} from "./modelPicker";

const PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "antigravity", name: "Antigravity" },
] as const;

/** Last known catalog per Provider, so reopening the picker is instant. */
const catalogCache = new Map<string, ModelInfo[]>();

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
  anchorElement?: HTMLElement | null;
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
  anchorElement = null,
}: ModelEffortPickerProps) {
  const [activeTab, setActiveTab] = useState<string>(currentProvider);
  const [search, setSearch] = useState("");
  const [favourites, setFavourites] = useState<string[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>(() =>
    Object.fromEntries(catalogCache)
  );
  const [loading, setLoading] = useState(false);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(currentEffort);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const [effortMenuPosition, setEffortMenuPosition] = useState({
    top: 0,
    left: 0,
    ready: false,
  });

  const modelSwitchLocked = turnCount > 0 && !midThreadModelSwitch;

  const effortMode = initialMode === "effort";

  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus();
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !effortMode || !anchorElement) return;

    const updatePosition = () => {
      const menu = effortMenuRef.current;
      if (!menu) return;

      const triggerRect = anchorElement.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const left = Math.min(
        Math.max(12, triggerRect.left),
        Math.max(12, window.innerWidth - menuRect.width - 12)
      );
      const top = Math.max(12, triggerRect.top - menuRect.height - 8);

      setEffortMenuPosition((current) =>
        current.ready && current.top === top && current.left === left
          ? current
          : { top, left, ready: true }
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, effortMode, anchorElement]);

  useEffect(() => {
    if (!open || !effortMode) return;

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (effortMenuRef.current?.contains(target) || anchorElement?.contains(target)) return;
      if (target instanceof Element && target.closest(".dropdown-menu")) return;
      onClose();
    };

    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [open, effortMode, anchorElement, onClose]);

  // Load favourites and refresh catalogs
  useEffect(() => {
    if (!open) return;
    let active = true;

    async function load() {
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

      const apply = (p: string, list: ModelInfo[]) => {
        catalogCache.set(p, list);
        if (active) setCatalogs((prev) => ({ ...prev, [p]: list }));
      };

      // Each Provider lands as soon as it answers; the slow ones (spawning a CLI)
      // never hold up the others. Cached lists show instantly, then refresh quietly.
      let pending = providersToFetch.length;
      if (!providersToFetch.every((p) => catalogCache.has(p))) setLoading(true);
      await Promise.all(
        providersToFetch.map(async (p) => {
          try {
            if (!catalogCache.has(p)) {
              const cached = await commands.getModelCatalog(p, false);
              if (cached.status === "ok") apply(p, cached.data);
            }
            const fresh = await commands.getModelCatalog(p, true);
            if (fresh.status === "ok" && fresh.data.length > 0) apply(p, fresh.data);
          } finally {
            pending -= 1;
            if (active && pending === 0) setLoading(false);
          }
        })
      );
    }

    void load();
    return () => {
      active = false;
    };
  }, [open, currentProvider]);

  const toggleFavourite = async (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const family = modelFamilyId(modelId);
    const isFav = favourites.some((id) => modelFamilyId(id) === family);
    const next = isFav
      ? favourites.filter((id) => modelFamilyId(id) !== family)
      : [...favourites, family];
    setFavourites(next);
    await commands.setFavouriteModels(next);
  };

  // Determine models for the current tab
  const tabModels = useMemo(() => {
    if (activeTab === "favourites") {
      const allModels = Object.values(catalogs).flat();
      const favouriteModels = allModels.filter((model) =>
        favourites.some((id) => modelFamilyId(id) === modelFamilyId(model.id))
      );
      return collapseEffortVariants(favouriteModels, selectedEffort);
    }
    return collapseEffortVariants(catalogs[activeTab] || [], selectedEffort);
  }, [activeTab, catalogs, favourites, selectedEffort]);

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
    if (effortMode) {
      onClose();
      anchorElement?.focus();
    }
  };

  // Keyboard shortcut listener: ⌘1-9 and Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        if (effortMode) anchorElement?.focus();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const index = parseInt(e.key, 10);
        const target = applyModelShortcut(index, flatVisible);
        if (target) {
          const isOtherProvider = activeTab !== currentProvider && activeTab !== "favourites";
          const isLocked = !isOtherProvider && modelSwitchLocked;
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
    anchorElement,
    effortMode,
    modelSwitchLocked,
    handleSelectModel,
    onClose,
  ]);

  if (!open) return null;

  const isOtherProvider = activeTab !== currentProvider && activeTab !== "favourites";
  const startsNewThread = turnCount > 0 && isOtherProvider;

  if (effortMode) {
    const efforts = activeModelInfo?.supportedEfforts ?? [];
    const effortValue = efforts.includes(selectedEffort || "")
      ? selectedEffort!
      : activeModelInfo?.defaultEffort ?? efforts[0] ?? "";
    return (
      <div
        ref={effortMenuRef}
        className="effort-menu"
        role="group"
        aria-label="Reasoning effort"
        style={{
          top: `${effortMenuPosition.top}px`,
          left: `${effortMenuPosition.left}px`,
          visibility: effortMenuPosition.ready ? "visible" : "hidden",
        }}
      >
        {efforts.length === 0 ? (
          <span className="effort-label">
            {loading ? "Loading..." : "This model has no effort levels."}
          </span>
        ) : (
          <div className="effort-select-row">
            <span className="effort-label">Reasoning effort</span>
            <Dropdown
              label="Reasoning effort"
              value={effortValue}
              triggerClassName="effort-select-trigger"
              options={efforts.map((effort) => ({
                value: effort,
                label: effort.charAt(0).toUpperCase() + effort.slice(1),
              }))}
              onChange={handleSelectEffort}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Model Selector">
      <div className="modal model-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="model-picker-header">
          <h2>Model</h2>
          <button type="button" className="close-button" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </div>

        <div className="model-picker-layout">
          {/* Provider Rail */}
          <nav className="provider-rail" aria-label="Provider rail">
            <button
              type="button"
              className={`rail-tab ${activeTab === "favourites" ? "active" : ""}`}
              onClick={() => setActiveTab("favourites")}
            >
              <span className="rail-icon"><StarFillIcon size={14} /></span>
              <span className="rail-text">Favourites</span>
            </button>

            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`rail-tab ${activeTab === p.id ? "active" : ""}`}
                onClick={() => setActiveTab(p.id)}
              >
                <ProviderMark provider={p.id} size={14} />
                <span className="rail-text">{p.name}</span>
              </button>
            ))}

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

            {startsNewThread && (
              <div className="tab-info-banner" role="status">
                Picking a model from another Provider starts a new Thread.
              </div>
            )}

            {modelSwitchLocked && !isOtherProvider && (
              <div className="tab-locked-banner" role="status">
                <LockIcon size={12} /> Provider does not support mid-thread model switching.
              </div>
            )}

            <div className="models-list-scroll">
              {loading && flatVisible.length === 0 && <div className="models-loading">Loading catalog...</div>}

              {!loading && flatVisible.length === 0 && (
                <div className="models-empty">No models found.</div>
              )}

              {/* Active models section */}
              {visibleCurrent.length > 0 && (
                <div className="models-group">
                  <div className="models-group-title">Models</div>
                  {visibleCurrent.map((m, idx) => {
                    const isSelected = modelFamilyId(m.id) === modelFamilyId(currentModel ?? "");
                    const isFav = favourites.some(
                      (id) => modelFamilyId(id) === modelFamilyId(m.id)
                    );
                    const isItemLocked = !isOtherProvider && modelSwitchLocked && !isSelected;
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
                          {isFav ? <StarFillIcon size={14} /> : <StarIcon size={14} />}
                        </button>

                        <div className="model-details">
                          <div className="model-name-row">
                            <span className="model-name">{m.name}</span>
                            {isSelected && <span className="current-badge">Active</span>}
                            {isItemLocked && <span className="locked-badge"><LockIcon size={10} /> Locked</span>}
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
                    const isSelected = modelFamilyId(m.id) === modelFamilyId(currentModel ?? "");
                    const isFav = favourites.some(
                      (id) => modelFamilyId(id) === modelFamilyId(m.id)
                    );
                    const isItemLocked = !isOtherProvider && modelSwitchLocked && !isSelected;
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
                          {isFav ? <StarFillIcon size={14} /> : <StarIcon size={14} />}
                        </button>

                        <div className="model-details">
                          <div className="model-name-row">
                            <span className="model-name">{m.name}</span>
                            {isSelected && <span className="current-badge">Active</span>}
                            {isItemLocked && <span className="locked-badge"><LockIcon size={10} /> Locked</span>}
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
