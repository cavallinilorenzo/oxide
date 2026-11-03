import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Limit worker count so machines with many cores don't spawn more
    // isolated jsdom environments than the machine can comfortably run,
    // which caused flaky canvas/jsdom failures in AppGithubDock.
    maxWorkers: 4,
  },
});
