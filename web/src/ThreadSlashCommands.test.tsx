// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { ThreadView } from "./ThreadView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.render(null)); clearMocks(); localStorage.clear(); });

it("intercepts an unavailable permission mode before a Thread exists", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_settings") return { settings: { defaultProvider: "agy", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit", "full-access"] };
    if (command === "provider_capabilities") return { imageAttachments: false };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} projectPath="/test" draft="/permissions ask"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.textContent).toContain("Ask is not offered");
  expect(calls).not.toContain("create_thread");
  expect(calls).not.toContain("send_prompt");
  expect(container.querySelector('[aria-label^="Permission mode:"]')?.getAttribute("aria-label")).toContain("Auto-edit");
});


it("loads capabilities before applying a permission command in a new Thread", async () => {
  let requests = 0;
  mockIPC((command) => {
    if (command === "get_settings") return { settings: { defaultProvider: "codex", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") {
      requests++;
      return requests < 3 ? new Promise(() => {}) : { supportedPermissionModes: ["ask", "auto-edit", "full-access"] };
    }
    if (command === "provider_capabilities") return { imageAttachments: false };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} projectPath="/test" draft="/permissions full"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.querySelector('[aria-label^="Permission mode:"]')?.getAttribute("aria-label")).toContain("Full access");
  expect(container.textContent).not.toContain("not offered");
});


it.each(["claude", "codex", "agy"])("intercepts commands in a %s Thread without sending a Turn", async (provider) => {
  const calls: { command: string; args: unknown }[] = [];
  const openDiff = vi.fn();
  const titleChanged = vi.fn();
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "subscribe_thread") return {
      thread: { id: 7, projectId: 1, title: "Old", provider, permissionMode: "auto-edit", status: "completed" },
      capabilities: {}, turns: [], turnOffset: 0, turnCount: 0, lastSeq: 0,
      supportedPermissionModes: provider === "agy" ? ["auto-edit", "full-access"] : ["ask", "auto-edit", "full-access"],
    };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: provider === "agy" ? ["auto-edit", "full-access"] : ["ask", "auto-edit", "full-access"] };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog" || command === "list_slash_commands") return [];
    return null;
  });
  const render = (draft: string) => <ThreadView threadId={7} projectId={1} projectPath="/test" draft={draft}
    onOpenDefaultDiff={openDiff} onThreadCreated={vi.fn()} onStatusChange={vi.fn()} onThreadTitleChange={titleChanged}
    prefill={null} onPrefillUsed={vi.fn()} onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />;
  await act(async () => root.render(render("/rename New title")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "rename_thread" && (c.args as { title: string }).title === "New title")).toBe(true);
  expect(titleChanged).toHaveBeenCalledWith(7, "New title");
  await act(async () => root.render(render("/diff")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(openDiff).toHaveBeenCalledOnce();

  await act(async () => root.render(render("/reload-cache")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "list_slash_commands" && (c.args as { refresh: boolean; threadId: number }).refresh && (c.args as { threadId: number }).threadId === 7)).toBe(true);


  await act(async () => root.render(render("/permissions full")));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(calls.some((c) => c.command === "set_thread_permission_mode" && (c.args as { permissionMode: string }).permissionMode === "full-access")).toBe(true);
  expect(calls.some((c) => c.command === "send_prompt")).toBe(false);
});


it("reports a failed cache reload without sending the command to the provider", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_settings") return { settings: { defaultProvider: "agy", providers: {} }, errors: [] };
    if (command === "get_provider_capabilities") return { supportedPermissionModes: ["auto-edit"] };
    if (command === "provider_capabilities") return { imageAttachments: false };
    if (command === "git_status") return { branch: "main" };
    if (command === "get_model_catalog") return [];
    if (command === "list_slash_commands") throw "provider unavailable";
    return null;
  });
  await act(async () => root.render(<ThreadView threadId={null} projectId={1} projectPath="/test" draft="/reload-cache"
    onThreadCreated={vi.fn()} onStatusChange={vi.fn()} prefill={null} onPrefillUsed={vi.fn()}
    onOpenThread={vi.fn()} onThreadContinued={vi.fn()} />));
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.textContent).toContain("Could not refresh the Slash command catalog");
  expect(calls).not.toContain("send_prompt");
  expect(calls).not.toContain("create_thread");
});
