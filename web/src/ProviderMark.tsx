import { CodeIcon, BeakerIcon } from "@primer/octicons-react";
import { siClaude, siGooglegemini } from "simple-icons";

const SIMPLE_ICONS: Record<string, { title: string; path: string }> = {
  claude: siClaude,
  antigravity: siGooglegemini,
};

/** The Provider's brand mark (Simple Icons), or an Octicon where Simple Icons has none. */
export function ProviderMark({ provider, size = 14 }: { provider: string; size?: number }) {
  const icon = SIMPLE_ICONS[provider];
  if (icon) {
    return (
      <svg
        className="provider-mark"
        role="img"
        aria-label={icon.title}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d={icon.path} />
      </svg>
    );
  }
  // Codex (OpenAI) is not in Simple Icons; the fake Provider has no brand.
  const Fallback = provider === "codex" ? CodeIcon : BeakerIcon;
  return (
    <span className="provider-mark" role="img" aria-label={provider}>
      <Fallback size={size} />
    </span>
  );
}
