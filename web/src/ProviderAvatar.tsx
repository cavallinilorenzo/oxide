import { BeakerIcon } from "@primer/octicons-react";
import { OPENAI_PATH } from "./ProviderMark";
import { providerName } from "./headerLines";

/**
 * Large avatars for the Thread header. Claude Code and Antigravity are pixel art in the manner
 * of their CLI banners; Codex uses its OpenAI mark. Like `ProviderMark` they only identify the
 * Provider; the brands belong to Anthropic, Google and OpenAI.
 */

/** A pixel grid with one solid fill: `#` is a cell, `e` an eye, `.` nothing. */
interface PixelAvatar {
  grid: string[];
  fill: string;
}

/** A pixel grid with a colour per cell: space-separated hex colours, `.` for nothing. */
interface ColourAvatar {
  rows: string[];
}

// Clawd, Claude Code's crab.
const CLAWD: PixelAvatar = {
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
};

// The gradient "A" of the Antigravity CLI banner.
const ANTIGRAVITY: ColourAvatar = {
  rows: [
    ". . . . . e59746 e07946 . . . . .",
    ". . . . d4b34c e89646 e37a47 df6246 . . . .",
    ". . . a5c259 b5b452 d79c4f e68146 e77345 dd5f4b . . .",
    ". . . 94c45f 83b268 c49759 e07f53 d26d59 d0595d . . .",
    ". . 8cc060 84c068 6fa790 6890b0 8074ac 736fbd 9160a4 935e94 . .",
    ". . 90c463 6fb685 5895d8 . . 567ddd 706ec8 8966af . .",
    ". . 7ac183 62acaa . . . . 577fe3 6d73d1 . .",
    ". 83c498 78b8d2 62a6d7 . . . . 5187f3 5780e8 6978da .",
    ". 82c5a5 78b4f1 . . . . . . 4d84f3 5680ec .",
    "7bb7ef 78b4f1 . . . . . . . . 4c81f1 5083f4",
  ],
};

const CELL = 5;
const EYE = "#1b1b1f";

function Pixels({ provider, cells, height }: { provider: string; cells: (string | null)[][]; height: number }) {
  const rows = cells.length;
  const cols = cells[0].length;
  return (
    <svg
      className="provider-avatar"
      role="img"
      aria-label={providerName(provider)}
      viewBox={`0 0 ${cols * CELL} ${rows * CELL}`}
      height={height}
      width={(height * cols) / rows}
      shapeRendering="crispEdges"
    >
      {cells.flatMap((line, y) =>
        line.map((fill, x) =>
          fill === null ? null : (
            <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL} height={CELL} fill={fill} />
          ),
        ),
      )}
    </svg>
  );
}

function solidCells({ grid, fill }: PixelAvatar): (string | null)[][] {
  return grid.map((line) => [...line].map((cell) => (cell === "." ? null : cell === "e" ? EYE : fill)));
}

function colourCells({ rows }: ColourAvatar): (string | null)[][] {
  const cols = Math.max(...rows.map((row) => row.split(" ").length));
  return rows.map((row) => {
    const cells = row.split(" ").map((token) => (token === "." ? null : `#${token}`));
    return [...cells, ...Array<null>(cols - cells.length).fill(null)];
  });
}

const CLAWD_CELLS = solidCells(CLAWD);
const ANTIGRAVITY_CELLS = colourCells(ANTIGRAVITY);

/** The Thread's Provider as a large avatar. */
export function ProviderAvatar({ provider, height = 36 }: { provider: string; height?: number }) {
  if (provider === "claude") return <Pixels provider={provider} cells={CLAWD_CELLS} height={height} />;
  if (provider === "antigravity" || provider === "agy") {
    return <Pixels provider={provider} cells={ANTIGRAVITY_CELLS} height={height} />;
  }
  if (provider === "codex") {
    return (
      <svg
        className="provider-avatar"
        role="img"
        aria-label={providerName(provider)}
        viewBox="0 0 24 24"
        width={height}
        height={height}
        fill="currentColor"
      >
        <path d={OPENAI_PATH} />
      </svg>
    );
  }
  // The fake Provider used in tests has no brand.
  return (
    <span className="provider-avatar" role="img" aria-label={providerName(provider)} style={{ height }}>
      <BeakerIcon size={height * 0.7} />
    </span>
  );
}
