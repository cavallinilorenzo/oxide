import { modelDigitShortcut, shortcutLabel } from "./shortcuts";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, LockIcon, StarFillIcon, StarIcon, XIcon } from "@primer/octicons-react";
import { commands, type ModelInfo } from "./bindings";
import { ProviderMark } from "./ProviderMark";
import { catalogCache } from "./modelCatalogCache";
import {
  modelFamilyId,
  openPicker,
  pickerReduce,
  pickerRows,
  resolvePickerChoice,
  type PickerAction,
  type PickerContext,
  type PickerRow,
  type PickerState,
} from "./modelPicker";

const PROVIDERS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "antigravity", name: "Antigravity" },
] as const;

const TAB_KEY = "oxide:model-picker-tab";

function rememberedTab(fallback: string): string {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return saved && (saved === "favourites" || PROVIDERS.some((p) => p.id === saved)) ? saved : fallback;
  } catch { return fallback; }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
}: ModelEffortPickerProps) {
  const [favourites, setFavourites] = useState<string[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>(() =>
    Object.fromEntries(catalogCache)
  );
  const [loading, setLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const modelSwitchLocked = turnCount > 0 && !midThreadModelSwitch;

  const ctx = useMemo<PickerContext>(
    () => ({
      tabs: ["favourites", ...PROVIDERS.map((p) => p.id), ...(currentProvider === "fake" ? ["fake"] : [])],
      catalogs,
      favourites,
      currentProvider,
      currentModel,
      locked: modelSwitchLocked,
    }),
    [catalogs, favourites, currentProvider, currentModel, modelSwitchLocked]
  );
  const ctxRef = useRef(ctx);
  useLayoutEffect(() => { ctxRef.current = ctx; });

  const [state, setState] = useState<PickerState>(() =>
    openPicker(ctx, rememberedTab(currentProvider), currentEffort)
  );
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; });
  const dispatch = useCallback(
    (action: PickerAction) => setState((s) => pickerReduce(s, action, ctxRef.current)),
    []
  );

  // Catalogs and Favourites land after opening; keep the highlight on a row that exists.
  useEffect(() => dispatch({ type: "sync" }), [ctx, dispatch]);

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, state.tab); } catch { /* The picker still works without storage. */ }
  }, [state.tab]);

  useEffect(() => {
    if (open) searchInputRef.current?.focus();
  }, [open]);

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

  const { current: visibleCurrent, legacy: visibleLegacy } = useMemo(
    () => pickerRows(ctx, state.tab, state.search, state.effort),
    [ctx, state.tab, state.search, state.effort]
  );
  const flatVisible = useMemo(() => [...visibleCurrent, ...visibleLegacy], [visibleCurrent, visibleLegacy]);
  const highlightedIndex = flatVisible.findIndex(
    (r) => !r.locked && modelFamilyId(r.model.id) === state.highlighted
  );
  const highlightedModel = flatVisible[highlightedIndex]?.model;
  const optionId = (index: number) => `model-option-${index}`;

  useEffect(() => {
    if (highlightedIndex < 0) return;
    document.getElementById(optionId(highlightedIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  /** Apply `row` with the Effort the slider would show for it, and close. */
  const applyRow = useCallback(
    (row: PickerRow) => {
      if (row.locked) return;
      const aimed = pickerReduce(stateRef.current, { type: "hover", family: modelFamilyId(row.model.id) }, ctxRef.current);
      const choice = resolvePickerChoice(aimed, ctxRef.current);
      if (!choice) return;
      onSelectModelAndEffort(choice.provider, choice.model, choice.effort);
      onClose();
    },
    [onSelectModelAndEffort, onClose]
  );

  // The search field keeps focus, so the picker handles its keys at the window.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => { keyHandlerRef.current = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const index = modelDigitShortcut(e);
    if (index !== null) {
      e.preventDefault();
      const row = flatVisible[index - 1];
      if (row) applyRow(row);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown": dispatch({ type: "move", delta: 1 }); break;
      case "ArrowUp": dispatch({ type: "move", delta: -1 }); break;
      case "ArrowRight": dispatch({ type: "step-effort", delta: 1 }); break;
      case "ArrowLeft": dispatch({ type: "step-effort", delta: -1 }); break;
      case "Tab": dispatch({ type: "cycle-tab", delta: e.shiftKey ? -1 : 1 }); break;
      case "Enter": {
        if (e.isComposing) return;
        const choice = resolvePickerChoice(stateRef.current, ctxRef.current);
        if (choice) {
          onSelectModelAndEffort(choice.provider, choice.model, choice.effort);
          onClose();
        }
        break;
      }
      default: return;
    }
    e.preventDefault();
  }; });
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const isOtherProvider = state.tab !== currentProvider && state.tab !== "favourites";
  const highlightedProvider = flatVisible[highlightedIndex]?.provider;
  const startsNewThread = turnCount > 0 && !!highlightedProvider && highlightedProvider !== currentProvider;
  const efforts = highlightedModel?.supportedEfforts ?? [];
  const effortIndex = efforts.indexOf(state.effort ?? "");
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  const renderRow = (row: PickerRow, index: number, legacy: boolean) => {
    const m = row.model;
    const family = modelFamilyId(m.id);
    const isFav = favourites.some((id) => modelFamilyId(id) === family);
    const isHighlighted = index === highlightedIndex;
    const shortcutNumber = index + 1 <= 9 ? index + 1 : null;
    return (
      <div
        key={m.id}
        id={optionId(index)}
        className={`model-row ${legacy ? "legacy-row" : ""} ${row.isCurrent ? "selected" : ""} ${
          isHighlighted ? "highlighted" : ""
        } ${row.locked ? "locked" : ""}`}
        onClick={() => applyRow(row)}
        onMouseMove={() => dispatch({ type: "hover", family })}
        onMouseDown={keepFocus}
        role="option"
        aria-selected={isHighlighted}
        aria-disabled={row.locked}
      >
        <button
          type="button"
          className="fav-toggle-btn"
          tabIndex={-1}
          onClick={(e) => void toggleFavourite(m.id, e)}
          aria-label={isFav ? "Unfavourite" : "Favourite"}
        >
          {isFav ? <StarFillIcon size={14} /> : <StarIcon size={14} />}
        </button>

        <div className="model-details">
          <div className="model-name-row">
            <span className="model-name">{m.name}</span>
            {row.isCurrent && <span className="current-badge">Active</span>}
            {row.locked && <span className="locked-badge"><LockIcon size={10} /> Locked</span>}
          </div>
          {m.description && <div className="model-desc">{m.description}</div>}
        </div>

        {shortcutNumber && (
          <span className="model-shortcut" title={`${shortcutLabel}${shortcutNumber}`}>
            {shortcutLabel}{shortcutNumber}
          </span>
        )}
      </div>
    );
  };

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
              tabIndex={-1}
              className={`rail-tab ${state.tab === "favourites" ? "active" : ""}`}
              aria-current={state.tab === "favourites"}
              onMouseDown={keepFocus}
              onClick={() => dispatch({ type: "set-tab", tab: "favourites" })}
            >
              <span className="rail-icon"><StarFillIcon size={14} /></span>
              <span className="rail-text">Favourites</span>
            </button>

            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                tabIndex={-1}
                className={`rail-tab ${state.tab === p.id ? "active" : ""}`}
                aria-current={state.tab === p.id}
                onMouseDown={keepFocus}
                onClick={() => dispatch({ type: "set-tab", tab: p.id })}
              >
                <ProviderMark provider={p.id} size={14} />
                <span className="rail-text">{p.name}</span>
              </button>
            ))}

            {currentProvider === "fake" && (
              <button
                type="button"
                tabIndex={-1}
                className={`rail-tab ${state.tab === "fake" ? "active" : ""}`}
                aria-current={state.tab === "fake"}
                onMouseDown={keepFocus}
                onClick={() => dispatch({ type: "set-tab", tab: "fake" })}
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
                role="combobox"
                aria-expanded="true"
                aria-controls="model-listbox"
                aria-activedescendant={highlightedIndex >= 0 ? optionId(highlightedIndex) : undefined}
                placeholder="Search models..."
                value={state.search}
                onChange={(e) => dispatch({ type: "search", text: e.target.value })}
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

              <div id="model-listbox" role="listbox" aria-label="Models" className="models-listbox">
                {visibleCurrent.length > 0 && (
                  <div className="models-group" role="group" aria-label="Models">
                    <div className="models-group-title" aria-hidden="true">Models</div>
                    {visibleCurrent.map((row, idx) => renderRow(row, idx, false))}
                  </div>
                )}

                {visibleLegacy.length > 0 && (
                  <div className="models-group legacy-group" role="group" aria-label="Legacy Models">
                    <div className="models-group-title" aria-hidden="true">Legacy Models</div>
                    {visibleLegacy.map((row, idx) => renderRow(row, visibleCurrent.length + idx, true))}
                  </div>
                )}
              </div>
            </div>

            <div className="effort-slider">
              {efforts.length === 0 ? (
                <span className="effort-label">
                  {highlightedModel ? "This model has no effort levels." : "Select a model to see its effort levels."}
                </span>
              ) : (
                <>
                  <span className="effort-label">Effort</span>
                  <button
                    type="button"
                    className="effort-step"
                    tabIndex={-1}
                    aria-label="Lower effort"
                    disabled={effortIndex <= 0}
                    onMouseDown={keepFocus}
                    onClick={() => dispatch({ type: "step-effort", delta: -1 })}
                  >
                    <ChevronLeftIcon size={14} />
                  </button>
                  <div
                    className="effort-stops"
                    role="slider"
                    aria-label="Effort"
                    aria-valuemin={0}
                    aria-valuemax={efforts.length - 1}
                    aria-valuenow={Math.max(0, effortIndex)}
                    aria-valuetext={capitalise(state.effort ?? efforts[0]!)}
                  >
                    {efforts.map((effort) => (
                      <span
                        key={effort}
                        className={`effort-stop ${effort === state.effort ? "active" : ""}`}
                        onMouseDown={keepFocus}
                        onClick={() => dispatch({ type: "set-effort", effort })}
                      >
                        {capitalise(effort)}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="effort-step"
                    tabIndex={-1}
                    aria-label="Raise effort"
                    disabled={effortIndex >= efforts.length - 1}
                    onMouseDown={keepFocus}
                    onClick={() => dispatch({ type: "step-effort", delta: 1 })}
                  >
                    <ChevronRightIcon size={14} />
                  </button>
                </>
              )}
            </div>

            <div className="picker-legend">
              ↑↓ Model · ←→ Effort · Tab Provider · ↩ Select · Esc Close
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
