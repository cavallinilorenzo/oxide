export type PanelBounds = { value: number; min: number; max: number };

/** Narrowest the tools panel can get before the merge footer (three buttons + gear) no longer fits. */
export const TOOLS_MIN = 496;

export function panelBounds(preferred: number | null, fallback: number, min: number, max: number): PanelBounds {
  const upper = Math.max(min, Math.floor(max));
  return { value: Math.round(Math.min(upper, Math.max(min, preferred ?? fallback))), min, max: Math.floor(upper) };
}

/** Fit visible panels without overwriting the user's preferred wide-window sizes. */
export function workspaceLayout(
  width: number,
  height: number,
  preferred: { sidebar: number | null; tools: number | null; terminal: number | null },
  toolsVisible: boolean,
) {
  const centreMin = 360;
  const sidebarMin = 208;
  const toolsMin = toolsVisible ? TOOLS_MIN : 0;
  const sidebar = panelBounds(preferred.sidebar, width <= 1100 ? 208 : 240, sidebarMin,
    Math.min(400, width - toolsMin - centreMin));
  const tools = panelBounds(preferred.tools, Math.min(600, Math.max(TOOLS_MIN, width * 0.32)), TOOLS_MIN,
    Math.min(800, width - sidebar.value - centreMin));
  // During drag each panel must also respect the other panel's current size.
  sidebar.max = Math.floor(Math.max(sidebarMin, Math.min(400, width - (toolsVisible ? tools.value : 0) - centreMin)));
  const terminal = panelBounds(preferred.terminal, Math.min(220, Math.max(140, (height + 44) * 0.25)),
    140, Math.min(600, height - 280));
  return { sidebar, tools, terminal };
}

export function fileTreeLayout(width: number, height: number, preferred: { width: number | null; height: number | null }) {
  const axis = width > 560 ? "x" : "y";
  const bounds = axis === "x"
    ? panelBounds(preferred.width, width * 0.34, 144, Math.min(480, width - 200))
    : panelBounds(preferred.height, Math.max(120, height * 0.38), 80, height - 120);
  return { axis, ...bounds } as const;
}
