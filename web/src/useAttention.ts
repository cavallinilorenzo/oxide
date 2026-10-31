import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { commands, type BoardEvent } from "./bindings";
import { applyBoardEvent, mergeCard } from "./board";
import type { CardsByProject } from "./attention";

/**
 * Board cards of every given Project, kept live through the Board feed (status and pending Approvals only,
 * never a Transcript). A subscription lives as long as its Project stays in `projectIds`.
 */
export function useAttention(projectIds: number[]): CardsByProject {
  const [cards, setCards] = useState<CardsByProject>({});
  const subscriptions = useRef(new Map<number, () => void>());
  const key = projectIds.join(",");

  useEffect(() => {
    const wanted = new Set(key ? key.split(",").map(Number) : []);
    for (const [projectId, stop] of subscriptions.current) {
      if (wanted.has(projectId)) continue;
      stop();
      subscriptions.current.delete(projectId);
      setCards((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => Number(id) !== projectId)));
    }
    for (const projectId of wanted) {
      if (subscriptions.current.has(projectId)) continue;
      let active = true;
      const channel = new Channel<BoardEvent>();
      channel.onmessage = (event) => {
        if (active) setCards((previous) => ({ ...previous, [projectId]: applyBoardEvent(previous[projectId] ?? [], event) }));
      };
      subscriptions.current.set(projectId, () => { active = false; channel.onmessage = () => {}; });
      void commands.subscribeBoard(projectId, channel).then((result) => {
        // Events that raced ahead of the snapshot are newer: keep them.
        if (active && result.status === "ok") setCards((previous) => ({ ...previous, [projectId]: (result.data ?? []).reduce(mergeCard, previous[projectId] ?? []) }));
      }).catch(() => { /* Attention stays as last known; the Board itself reports feed errors. */ });
    }
  }, [key]);

  useEffect(() => {
    const live = subscriptions.current;
    return () => { for (const stop of live.values()) stop(); live.clear(); };
  }, []);

  return cards;
}
