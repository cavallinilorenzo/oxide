import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface PopoverProps {
  /** The button that opens it; clicks on it are the caller's to handle. */
  anchor: RefObject<HTMLElement | null>;
  label: string;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}

/** A small panel anchored to a button, above or below it as there is room. It is placed in
 *  the viewport, so the scrolling pull request panel can't clip it. */
export function Popover({ anchor, label, onClose, width = 280, children }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass inline closures: keep the listeners from being rebuilt (and focus stolen) per render.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    const el = panel.current;
    if (!rect || !el) return;
    const w = Math.min(width, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const upward = below < 260 && above > below;
    Object.assign(el.style, {
      width: `${w}px`,
      left: `${Math.max(8, Math.min(rect.right - w, window.innerWidth - w - 8))}px`,
      maxHeight: `${Math.max(120, Math.min(480, upward ? above : below))}px`,
      top: upward ? "auto" : `${rect.bottom + 4}px`,
      bottom: upward ? `${window.innerHeight - rect.top + 4}px` : "auto",
      visibility: "visible",
    });
  }, [anchor, width]);

  useEffect(() => {
    const trigger = anchor.current;
    const onClose = () => close.current();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panel.current?.contains(target) && !trigger?.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      trigger?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    // Scrolling or resizing would leave it floating away from its button.
    window.addEventListener("resize", onClose);
    const scroller = trigger?.closest(".pr-scroll");
    scroller?.addEventListener("scroll", onClose);
    panel.current?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", onClose);
      scroller?.removeEventListener("scroll", onClose);
    };
  }, [anchor]);

  return createPortal(
    <div ref={panel} className="pr-popover" role="dialog" aria-label={label} style={{ visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}
