import { useState } from "react";
import { avatarUrl } from "./pullRequestReview";

/** A GitHub user's avatar; the initial stands in until it loads, or if it can't. */
export function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const initial = login.replace(/^app\//, "").charAt(0).toUpperCase() || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5) };
  if (!login || failed === login) {
    return (
      <span className="avatar avatar-fallback" style={style} aria-hidden>
        {initial}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      src={avatarUrl(login, size * 2)}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setFailed(login)}
    />
  );
}
