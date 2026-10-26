import { BeakerIcon } from "@primer/octicons-react";
import { providerName } from "./headerLines";

/**
 * Pixel-art marks for the Thread header, in the manner of the Claude Code and Antigravity CLI
 * banners. `#` is a filled cell, `e` an eye, `.` an empty one. Like `ProviderMark` they only
 * identify the Provider; the brands belong to Anthropic, Google and OpenAI.
 */
const AVATARS: Record<string, { grid: string[]; fill: string }> = {
  // Clawd, Claude Code's crab.
  claude: {
    fill: "#d97757",
    grid: [
      "..########..",
      "..#e####e#..",
      "############",
      "############",
      "..########..",
      "..#.#..#.#..",
      "..#.#..#.#..",
    ],
  },
  // The pixel "A" of the `agy` banner.
  antigravity: {
    fill: "#4796e3",
    grid: [
      "....#....",
      "...###...",
      "..##.##..",
      "..#...#..",
      ".#######.",
      ".#.....#.",
      "##.....##",
    ],
  },
  // A cloud with a prompt cut out of it.
  codex: {
    fill: "currentColor",
    grid: [
      ".#######.",
      "#########",
      "##.######",
      "###.#####",
      "##.##...#",
      "#########",
      ".#######.",
    ],
  },
};
AVATARS.agy = AVATARS.antigravity;

const CELL = 5;
const EYE = "#1b1b1f";

/** The Thread's Provider as a large pixel-art avatar. */
export function ProviderAvatar({ provider, height = 36 }: { provider: string; height?: number }) {
  const avatar = AVATARS[provider];
  if (!avatar) {
    // The fake Provider used in tests has no brand.
    return (
      <span className="provider-avatar" role="img" aria-label={providerName(provider)} style={{ height }}>
        <BeakerIcon size={height * 0.7} />
      </span>
    );
  }
  const rows = avatar.grid.length;
  const cols = avatar.grid[0].length;
  return (
    <svg
      className="provider-avatar"
      role="img"
      aria-label={providerName(provider)}
      viewBox={`0 0 ${cols * CELL} ${rows * CELL}`}
      height={height}
      width={(height * cols) / rows}
      shapeRendering="crispEdges"
      fill={avatar.fill}
    >
      {avatar.grid.flatMap((line, y) =>
        [...line].map((cell, x) =>
          cell === "." ? null : (
            <rect
              key={`${x}-${y}`}
              x={x * CELL}
              y={y * CELL}
              width={CELL}
              height={CELL}
              fill={cell === "e" ? EYE : undefined}
            />
          ),
        ),
      )}
    </svg>
  );
}
