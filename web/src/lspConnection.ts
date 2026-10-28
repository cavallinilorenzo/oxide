import { Channel } from "@tauri-apps/api/core";
import { commands, type LanguageTool } from "./bindings";
import type {
  Diagnostic,
  InitializeResult,
  ServerCapabilities,
} from "vscode-languageserver-protocol";

type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class LspConnection {
  private id: number | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private outbound: Promise<void> = Promise.resolve();
  private stopped = false;
  capabilities: ServerCapabilities = {};
  root = "";
  constructor(
    private projectId: number,
    private threadId: number | null,
    readonly tool: LanguageTool,
    private onDiagnostics: (uri: string, diagnostics: Diagnostic[]) => void,
    private onState: (state: string) => void,
  ) {}

  async start(toUri: (path: string) => string) {
    this.onState("Connecting…");
    const channel = new Channel<string>();
    channel.onmessage = (raw) => {
      try {
        this.receive(JSON.parse(raw) as Message);
      } catch {
        /* A malformed notification cannot break editing. */
      }
    };
    const result = await commands.startLanguageServer(
      this.projectId,
      this.threadId,
      this.tool.language,
      channel,
    );
    if (result.status === "error") throw new Error(result.error.message);
    this.id = result.data.id;
    if (this.stopped) {
      await commands.stopLanguageServer(result.data.id);
      throw new Error("Language server closed.");
    }
    this.root = toUri(result.data.root);
    const initialized = await this.request<InitializeResult>("initialize", {
      processId: null,
      rootUri: this.root,
      workspaceFolders: [{ uri: this.root, name: "Project" }],
      clientInfo: { name: "Oxide", version: "0.1.0" },
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: JSON.parse(
        result.data.initializationOptions || "{}",
      ) as unknown,
    });
    this.capabilities = initialized.capabilities;
    await this.notify("initialized", {});
    await this.notify("workspace/didChangeConfiguration", {
      settings: this.settings(),
    });
    this.onState("Ready");
  }
  private settings() {
    return {
      python: {
        ...(this.tool.config.interpreter
          ? { pythonPath: this.tool.config.interpreter }
          : {}),
        analysis: {
          diagnosticMode: "openFilesOnly",
          autoSearchPaths: true,
          useLibraryCodeForTypes: true,
        },
      },
    };
  }
  private receive(message: Message) {
    if (this.stopped) return;
    if (message.method) {
      if (message.id !== undefined) {
        let result: unknown = null;
        if (message.method === "workspace/configuration") {
          const items =
            (message.params as { items?: { section?: string }[] })?.items ?? [];
          result = items.map(({ section }) => {
            let value: unknown = this.settings();
            for (const part of section?.split(".") ?? [])
              value = (value as Record<string, unknown> | undefined)?.[part];
            return value ?? null;
          });
        } else if (message.method === "workspace/workspaceFolders")
          result = [{ uri: this.root, name: "Project" }];
        else if (message.method === "workspace/applyEdit")
          result = {
            applied: false,
            failureReason: "Use an editor action to apply changes.",
          };
        void this.send({ jsonrpc: "2.0", id: message.id, result }).catch(
          () => {},
        );
      } else if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as {
          uri: string;
          diagnostics: Diagnostic[];
        };
        this.onDiagnostics(params.uri, params.diagnostics);
      } else if (message.method === "$/oxide/serverExited") {
        this.onState("Server stopped. Reconnect from Language tools.");
        this.rejectPending("Language server exited.");
      }
      return;
    }
    const pending =
      typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
  private send(message: object): Promise<void> {
    const id = this.id;
    if (id === null || this.stopped)
      return Promise.reject(new Error("Language server is disconnected."));
    const next = this.outbound.then(async () => {
      const result = await commands.languageServerMessage(
        id,
        JSON.stringify(message),
      );
      if (result.status === "error") throw new Error(result.error.message);
    });
    this.outbound = next.catch(() => {});
    return next;
  }
  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch(
        (error: Error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }
  notify(method: string, params: unknown) {
    return this.send({ jsonrpc: "2.0", method, params });
  }
  private rejectPending(reason: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
  dispose() {
    this.stopped = true;
    this.rejectPending("Editor closed.");
    if (this.id !== null) void commands.stopLanguageServer(this.id);
  }
}
