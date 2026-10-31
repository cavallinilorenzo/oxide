import { useEffect } from "react";
import type { AttentionTarget } from "./attention";

const RESPONSE = {
  approval: '.centre [aria-label="Approval"].pending .approval-btn.allow',
  composer: '.centre [role="textbox"][contenteditable="true"]',
};

/**
 * Focuses the response a jump asked for once its Thread is on screen (`shown`), then calls `onFocused`.
 * Gives up after a few seconds with `onFailed`; the jump stays requested so the user can retry.
 * Only a jump starts this: background updates never reach it.
 */
export function useAttentionFocus(target: AttentionTarget | null, shown: boolean, onFocused: () => void, onFailed: () => void) {
  useEffect(() => {
    if (!target) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const response = shown ? document.querySelector<HTMLElement>(target.kind === "approval" ? RESPONSE.approval : RESPONSE.composer) : null;
      if (response) {
        window.clearInterval(timer);
        response.focus();
        onFocused();
      } else if (Date.now() - started > 4000) {
        window.clearInterval(timer);
        onFailed();
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [target, shown, onFocused, onFailed]);
}
