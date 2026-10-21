# React for the webview frontend

Oxide's webview frontend is React (with TanStack Virtual for the transcript). A spike that rendered the same streaming transcript in React 19, Solid 1.9 and Svelte 5 inside Tauri found them tied on streaming: about 60 fps with per-frame coalesced deltas, the same ~2-frame latency, and similar webview memory. The only measured gap was jump-scrolling a 10k-message history, where React dropped about a third as many frames. That gap comes from the TanStack React adapter rendering scroll updates synchronously, not from React's raw speed, and React's adapter is also the most mature, with an official chat example. Solid and Svelte save about 55 KB gzip, which doesn't matter for a local app. Prototype and numbers: the `prototype/frontend-spike` branch.

## Consequences

- Per-token updates must never reach React directly. The frontend coalesces Provider deltas into at most one update per frame, keeps finalized messages memoized, and re-parses only the streaming one.
- The largest measured costs are framework-neutral and still need design: first-use Shiki grammar compilation (~570 ms), mounting a 10k-message history (~1 s), and webview memory growth from cached highlighted HTML (~700 MB peak).
