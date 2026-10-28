/** How an Effort looks in the Model picker: its colour and how much flourish it earns. */
export interface EffortLook {
  /** Accent colour of the label, marker and track fill. */
  color: string;
  /** 0 is static; each step up adds glow, pulse, shimmer or sparkles. */
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  /** Sparkles twinkling around the label. */
  sparkles: number;
}

const LEVELS: Record<string, EffortLook> = {
  none: { color: "#8994a9", tier: 0, sparkles: 0 },
  minimal: { color: "#8994a9", tier: 0, sparkles: 0 },
  low: { color: "#f2c14e", tier: 0, sparkles: 0 },
  medium: { color: "#5fc98c", tier: 1, sparkles: 0 },
  high: { color: "#9aa8ff", tier: 2, sparkles: 0 },
  xhigh: { color: "#b08cff", tier: 3, sparkles: 5 },
  max: { color: "#ee7f9d", tier: 4, sparkles: 9 },
  ultra: { color: "#ff7ad9", tier: 5, sparkles: 14 },
};

const BY_TIER = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The look of `effort`, the `index`th of `count` levels; names Oxide doesn't know are placed by position. */
export function effortLook(effort: string, index: number, count: number): EffortLook {
  const known = LEVELS[effort.toLowerCase()];
  if (known) return known;
  const step = count > 1 ? Math.round((index / (count - 1)) * (BY_TIER.length - 1)) : 0;
  return LEVELS[BY_TIER[step]!]!;
}

const BLURBS: Record<string, string> = {
  none: "No extra reasoning. Instant answers.",
  minimal: "Barely any reasoning. Near-instant answers.",
  low: "Fastest answers, lightest reasoning.",
  medium: "Balanced speed and depth.",
  high: "Deeper reasoning for harder problems.",
  xhigh: "Extended reasoning. Slower and costlier.",
  max: "Maximum reasoning. Can overthink, so use it sparingly.",
  ultra: "Beyond max. Keep it for the hardest problems.",
};

export function effortBlurb(effort: string): string {
  return BLURBS[effort.toLowerCase()] ?? "";
}
