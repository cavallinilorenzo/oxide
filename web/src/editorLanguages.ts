import type {
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  LocationLink,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { commands } from "./bindings";
import { monaco, serverLanguage } from "./editorRuntime";
import { LspConnection } from "./lspConnection";

const range = (r: Range) =>
  new monaco.Range(
    r.start.line + 1,
    r.start.character + 1,
    r.end.line + 1,
    r.end.character + 1,
  );
const position = (p: monaco.Position) => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});
const markdown = (value: string) => ({ value, isTrusted: false });

/** One checkout's language sessions. Monaco models remain usable while a server is missing or restarting. */
export class EditorLanguages {
  private documents = new Map<string, monaco.editor.ITextModel>();
  private clients = new Map<string, Promise<LspConnection>>();
  private liveConnections = new Set<LspConnection>();
  private generation = 0;
  private opened = new Set<string>();
  private sentVersions = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private registrations: monaco.IDisposable[] = [];
  private disposed = false;
  constructor(
    private projectId: number,
    private threadId: number | null,
    private onState: (language: string, state: string) => void,
    private ensureModel: (uri: monaco.Uri) => Promise<void>,
  ) {
    this.register();
  }
  private async connect(language: string): Promise<LspConnection> {
    let client = this.clients.get(language);
    if (!client) {
      const generation = this.generation;
      client = (async () => {
        const result = await commands.languageTools();
        const tool = result.find((t) => t.language === language);
        if (!tool?.installed)
          throw new Error("Not installed · open Language tools");
        const connection = new LspConnection(
          this.projectId,
          this.threadId,
          tool,
          (uri, diagnostics) => {
            if (generation === this.generation)
              this.diagnostics(uri, diagnostics);
          },
          (state) => {
            if (generation === this.generation) this.onState(language, state);
          },
        );
        this.liveConnections.add(connection);
        if (this.disposed) {
          connection.dispose();
          throw new Error("Editor closed");
        }
        try {
          await connection.start((path) => monaco.Uri.file(path).toString());
        } catch (error) {
          connection.dispose();
          throw error;
        }
        if (this.disposed || generation !== this.generation) {
          connection.dispose();
          throw new Error("Language server reconnected.");
        }
        return connection;
      })();
      this.clients.set(language, client);
    }
    return client;
  }
  private report(language: string, error: unknown) {
    if (!this.disposed)
      this.onState(
        language,
        error instanceof Error ? error.message : String(error),
      );
  }
  add(model: monaco.editor.ITextModel) {
    const generation = this.generation;
    const uri = model.uri.toString();
    this.documents.set(uri, model);
    const language = serverLanguage(model.getLanguageId());
    if (!language) return;
    void this.connect(language)
      .then(async (client) => {
        if (
          this.disposed ||
          generation !== this.generation ||
          this.documents.get(uri) !== model ||
          model.isDisposed()
        )
          return;
        const version = model.getVersionId();
        await client.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: model.uri.path.endsWith(".tsx")
              ? "typescriptreact"
              : model.uri.path.endsWith(".jsx")
                ? "javascriptreact"
                : model.getLanguageId(),
            version,
            text: model.getValue(),
          },
        });
        this.opened.add(uri);
        this.sentVersions.set(uri, version);
      })
      .catch((error) => {
        if (generation === this.generation) this.report(language, error);
      });
  }
  changed(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    clearTimeout(this.timers.get(uri));
    this.timers.set(
      uri,
      setTimeout(() => {
        void this.flush(model);
      }, 180),
    );
  }
  private async flush(model: monaco.editor.ITextModel) {
    const generation = this.generation;
    const uri = model.uri.toString();
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    const language = serverLanguage(model.getLanguageId());
    if (!language || !this.opened.has(uri) || model.isDisposed()) return;
    if (this.sentVersions.get(uri) === model.getVersionId()) return;
    try {
      const client = await this.connect(language);
      if (
        generation !== this.generation ||
        model.isDisposed() ||
        !this.owns(model)
      )
        return;
      const version = model.getVersionId();
      await client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: model.getValue() }],
      });
      this.sentVersions.set(uri, version);
    } catch (error) {
      this.report(language, error);
    }
  }
  saved(model: monaco.editor.ITextModel) {
    const language = serverLanguage(model.getLanguageId());
    if (!language) return;
    void this.flush(model)
      .then(() => this.connect(language))
      .then((client) =>
        client.notify("textDocument/didSave", {
          textDocument: { uri: model.uri.toString() },
          text: model.getValue(),
        }),
      )
      .catch((e) => this.report(language, e));
  }
  remove(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    this.documents.delete(uri);
    this.sentVersions.delete(uri);
    const language = serverLanguage(model.getLanguageId());
    if (language && this.opened.delete(uri))
      void this.connect(language)
        .then((client) =>
          client.notify("textDocument/didClose", { textDocument: { uri } }),
        )
        .catch(() => {});
    monaco.editor.setModelMarkers(model, "oxide-lsp", []);
  }
  reconnect() {
    this.generation++;
    for (const client of this.liveConnections) client.dispose();
    this.liveConnections.clear();
    this.clients.clear();
    this.opened.clear();
    this.sentVersions.clear();
    for (const model of this.documents.values()) this.add(model);
  }
  private diagnostics(uri: string, diagnostics: Diagnostic[]) {
    const model = this.documents.get(uri);
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      "oxide-lsp",
      diagnostics.map((d) => ({
        ...range(d.range),
        message: typeof d.message === "string" ? d.message : d.message.value,
        source: d.source,
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : d.severity === 4
                ? monaco.MarkerSeverity.Hint
                : monaco.MarkerSeverity.Info,
        code: d.code === undefined ? undefined : String(d.code),
      })),
    );
  }
  private owns(model: monaco.editor.ITextModel) {
    return this.documents.get(model.uri.toString()) === model;
  }
  private async query<T>(
    model: monaco.editor.ITextModel,
    method: string,
    params: object,
  ): Promise<T | null> {
    const language = serverLanguage(model.getLanguageId());
    if (!language || !this.owns(model)) return null;
    try {
      await this.flush(model);
      const client = await this.connect(language);
      const capability = (
        {
          "textDocument/completion": "completionProvider",
          "textDocument/hover": "hoverProvider",
          "textDocument/definition": "definitionProvider",
          "textDocument/references": "referencesProvider",
          "textDocument/formatting": "documentFormattingProvider",
          "textDocument/rename": "renameProvider",
        } as Record<string, keyof typeof client.capabilities>
      )[method];
      if (capability && !client.capabilities[capability]) return null;
      return await client.request<T>(method, {
        textDocument: { uri: model.uri.toString() },
        ...params,
      });
    } catch (error) {
      this.report(language, error);
      return null;
    }
  }
  private edits(edit: WorkspaceEdit): monaco.languages.WorkspaceEdit {
    const edits: monaco.languages.IWorkspaceTextEdit[] = [];
    for (const [uri, changes] of Object.entries(edit.changes ?? {})) {
      for (const change of changes)
        edits.push({
          resource: monaco.Uri.parse(uri),
          versionId: undefined,
          textEdit: { range: range(change.range), text: change.newText },
        });
    }
    for (const change of edit.documentChanges ?? []) {
      if (!("textDocument" in change)) continue;
      for (const text of change.edits)
        if ("newText" in text)
          edits.push({
            resource: monaco.Uri.parse(change.textDocument.uri),
            versionId: undefined,
            textEdit: { range: range(text.range), text: text.newText },
          });
    }
    return { edits };
  }
  private register() {
    for (const language of [
      "python",
      "c",
      "cpp",
      "javascript",
      "typescript",
      "rust",
    ]) {
      this.registrations.push(
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: [".", ":", ">", '"', "'", "/"],
          provideCompletionItems: async (model, at, context) => {
            const result = await this.query<CompletionItem[] | CompletionList>(
              model,
              "textDocument/completion",
              {
                position: position(at),
                context: {
                  triggerKind: context.triggerKind + 1,
                  triggerCharacter: context.triggerCharacter,
                },
              },
            );
            const items = Array.isArray(result)
              ? result
              : (result?.items ?? []);
            const word = model.getWordUntilPosition(at);
            return {
              incomplete:
                !Array.isArray(result) && (result?.isIncomplete ?? false),
              suggestions: items.map((item) => {
                const edit = item.textEdit;
                const target =
                  edit && ("range" in edit ? edit.range : edit.replace);
                return {
                  label: item.label,
                  kind: Math.max(0, (item.kind ?? 1) - 1),
                  insertText: edit?.newText ?? item.insertText ?? item.label,
                  insertTextRules:
                    item.insertTextFormat === 2
                      ? monaco.languages.CompletionItemInsertTextRule
                          .InsertAsSnippet
                      : undefined,
                  range: target
                    ? range(target)
                    : new monaco.Range(
                        at.lineNumber,
                        word.startColumn,
                        at.lineNumber,
                        word.endColumn,
                      ),
                  detail: item.detail,
                  documentation:
                    typeof item.documentation === "string"
                      ? item.documentation
                      : item.documentation
                        ? markdown(item.documentation.value)
                        : undefined,
                  sortText: item.sortText,
                  filterText: item.filterText,
                  additionalTextEdits: item.additionalTextEdits?.map((e) => ({
                    range: range(e.range),
                    text: e.newText,
                  })),
                };
              }),
            };
          },
        }),
      );
      this.registrations.push(
        monaco.languages.registerHoverProvider(language, {
          provideHover: async (model, at) => {
            const result = await this.query<Hover>(
              model,
              "textDocument/hover",
              { position: position(at) },
            );
            if (!result) return null;
            const contents = Array.isArray(result.contents)
              ? result.contents
              : [result.contents];
            return {
              range: result.range ? range(result.range) : undefined,
              contents: contents.map((value) =>
                markdown(
                  typeof value === "string"
                    ? value
                    : "language" in value
                      ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
                      : value.value,
                ),
              ),
            };
          },
        }),
      );
      this.registrations.push(
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: async (model, at) => {
            const result = await this.query<
              Location | Location[] | LocationLink[]
            >(model, "textDocument/definition", { position: position(at) });
            return (
              result ? (Array.isArray(result) ? result : [result]) : []
            ).map((location) =>
              "targetUri" in location
                ? {
                    uri: monaco.Uri.parse(location.targetUri),
                    range: range(location.targetSelectionRange),
                  }
                : {
                    uri: monaco.Uri.parse(location.uri),
                    range: range(location.range),
                  },
            );
          },
        }),
      );
      this.registrations.push(
        monaco.languages.registerReferenceProvider(language, {
          provideReferences: async (model, at, context) =>
            (
              (await this.query<Location[]>(model, "textDocument/references", {
                position: position(at),
                context,
              })) ?? []
            ).map((location) => ({
              uri: monaco.Uri.parse(location.uri),
              range: range(location.range),
            })),
        }),
      );
      this.registrations.push(
        monaco.languages.registerDocumentFormattingEditProvider(language, {
          provideDocumentFormattingEdits: async (model, options) =>
            (
              (await this.query<TextEdit[]>(model, "textDocument/formatting", {
                options,
              })) ?? []
            ).map((e) => ({ range: range(e.range), text: e.newText })),
        }),
      );
      this.registrations.push(
        monaco.languages.registerRenameProvider(language, {
          provideRenameEdits: async (model, at, newName) => {
            if (!this.owns(model)) return null;
            const result = await this.query<WorkspaceEdit>(
              model,
              "textDocument/rename",
              { position: position(at), newName },
            );
            if (result) {
              const edit = this.edits(result);
              try {
                for (const resource of new Set(
                  edit.edits.flatMap((e) =>
                    "resource" in e ? [e.resource.toString()] : [],
                  ),
                ))
                  await this.ensureModel(monaco.Uri.parse(resource));
                return edit;
              } catch (error) {
                return {
                  edits: [],
                  rejectReason:
                    error instanceof Error ? error.message : String(error),
                };
              }
            }
            return {
              edits: [],
              rejectReason: "Rename is unavailable. Check Language tools.",
            };
          },
        }),
      );
    }
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const registration of this.registrations) registration.dispose();
    for (const connection of this.liveConnections) connection.dispose();
    this.liveConnections.clear();
    this.clients.clear();
    this.documents.clear();
  }
}
