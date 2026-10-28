// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { LanguageTool } from "./bindings";
import { LspConnection } from "./lspConnection";

const tool: LanguageTool = {
  language: "typescript",
  name: "TypeScript",
  installed: true,
  resolvedPath: "/tools/server",
  installCommand: "",
  documentation: "",
  config: { command: "server", args: [], interpreter: "/env/python" },
};
afterEach(clearMocks);

it("uses Core's SDK options, correlates replies and answers interpreter configuration requests", async () => {
  let channel!: Channel<string>;
  const messages: {
    method?: string;
    id?: number;
    params?: Record<string, unknown>;
    result?: unknown;
  }[] = [];
  const stopped: number[] = [];
  mockIPC((command, args) => {
    if (command === "start_language_server") {
      channel = (args as { onMessage: Channel<string> }).onMessage;
      return {
        id: 7,
        root: "/project",
        language: "typescript",
        initializationOptions:
          '{"tsserver":{"path":"/tools/typescript/lib/tsserver.js"}}',
      };
    }
    if (command === "stop_language_server") {
      stopped.push((args as { id: number }).id);
      return null;
    }
    if (command === "language_server_message") {
      const message = JSON.parse((args as { message: string }).message);
      messages.push(message);
      if (message.method === "initialize")
        queueMicrotask(() =>
          channel.onmessage(
            JSON.stringify({
              id: message.id,
              result: { capabilities: { hoverProvider: true } },
            }),
          ),
        );
      if (message.method === "textDocument/hover")
        queueMicrotask(() =>
          channel.onmessage(
            JSON.stringify({
              id: message.id,
              result: { contents: "documentation" },
            }),
          ),
        );
      return null;
    }
    return null;
  });
  const connection = new LspConnection(
    1,
    null,
    tool,
    () => {},
    () => {},
  );
  await connection.start((path) => `file://${path}`);
  expect(messages[0]?.params?.initializationOptions).toEqual({
    tsserver: { path: "/tools/typescript/lib/tsserver.js" },
  });
  expect(connection.capabilities.hoverProvider).toBe(true);
  await expect(connection.request("textDocument/hover", {})).resolves.toEqual({
    contents: "documentation",
  });
  channel.onmessage(
    JSON.stringify({
      id: 88,
      method: "workspace/configuration",
      params: { items: [{ section: "python.pythonPath" }] },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(messages.find((m) => m.id === 88)?.result).toEqual(["/env/python"]);
  connection.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopped).toEqual([7]);
});

it("stops a process that finishes starting after its editor was closed", async () => {
  let finish!: (value: object) => void;
  const stopped: number[] = [];
  mockIPC((command, args) => {
    if (command === "start_language_server")
      return new Promise((resolve) => {
        finish = resolve;
      });
    if (command === "stop_language_server")
      stopped.push((args as { id: number }).id);
    return null;
  });
  const connection = new LspConnection(
    1,
    null,
    tool,
    () => {},
    () => {},
  );
  const starting = connection.start((path) => path);
  connection.dispose();
  finish({
    id: 9,
    root: "/project",
    language: "typescript",
    initializationOptions: "{}",
  });
  await expect(starting).rejects.toThrow("closed");
  expect(stopped).toEqual([9]);
});
