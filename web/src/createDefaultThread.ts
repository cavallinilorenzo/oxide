import { commands } from "./bindings";

/** Read Settings at creation time so every entry point uses the current defaults. */
export async function createDefaultThread(projectId: number) {
  const { settings } = await commands.getSettings();
  const provider = settings.defaultProvider || "claude";
  const defaults = settings.providers[provider];
  return commands.createThread(
    projectId,
    provider,
    defaults?.model ?? null,
    defaults?.effort ?? null,
    defaults?.permissionMode ?? null,
  );
}
