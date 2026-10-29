import { useEffect, useState, type RefObject } from "react";

export const SETTINGS_SECTIONS = [
  ["appearance", "Appearance"], ["dictation", "Dictation"], ["general", "General"], ["providers", "Providers"],
  ["github", "GitHub tools"], ["shortcuts", "Keyboard shortcuts"], ["updates", "Updates"],
] as const;

/** Track headings inside the Settings scroller, including layout changes. */
export function useSettingsSection(root: RefObject<HTMLElement | null>, ready: boolean) {
  const [active, setActive] = useState<string>("appearance");
  useEffect(() => {
    const element = root.current;
    if (!ready || !element) return;
    const update = () => {
      if (!element.clientHeight) return;
      const navigation = element.querySelector<HTMLElement>(".settings-nav")!;
      element.style.setProperty("--settings-nav-offset", `${navigation.offsetHeight + 24}px`);
      const top = navigation.getBoundingClientRect().bottom + 32;
      let current: string = "appearance";
      for (const [id] of SETTINGS_SECTIONS) {
        const heading = element.querySelector(`#settings-${id}`);
        if (heading && heading.getBoundingClientRect().top <= top) current = id;
      }
      if (element.scrollTop <= 0) current = "appearance";
      else if (element.scrollTop + element.clientHeight >= element.scrollHeight - (element.querySelector<HTMLElement>(":scope > .actions")?.offsetHeight ?? 0) - 24) current = "updates";
      setActive(current);
    };
    element.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    observer?.observe(element.querySelector(".settings-nav")!);
    element.querySelectorAll(":scope > .settings-section").forEach((section) => observer?.observe(section));
    update();
    return () => { element.removeEventListener("scroll", update); window.removeEventListener("resize", update); observer?.disconnect(); };
  }, [root, ready]);
  return active;
}
