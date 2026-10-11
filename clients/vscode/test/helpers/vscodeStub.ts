/**
 * Minimal stand-in for the `vscode` module, aliased in vitest.config.mts so
 * `src/session.ts` (vscode glue) can run under plain Node. It covers only the
 * API surface the session touches, records every side effect, and lets a test
 * script modal answers. It is a test double for VS Code, not for the session.
 */

export interface RecordedCommand {
  command: string;
  args: unknown[];
}

/** One native message call: text, the options object (modal/detail) and offered buttons. */
export interface RecordedMessage {
  message: string;
  options: { modal?: boolean; detail?: string } | undefined;
  items: string[];
}

export interface StubUri {
  scheme: string;
  path: string;
  fsPath: string;
  query: string;
  fragment: string;
  with(change: { scheme?: string; query?: string }): StubUri;
  toString(): string;
}

function makeUri(parts: { scheme: string; path: string; query: string; fragment: string }): StubUri {
  return {
    ...parts,
    fsPath: parts.path,
    with(change) {
      return makeUri({
        ...parts,
        ...(change.scheme !== undefined ? { scheme: change.scheme } : {}),
        ...(change.query !== undefined ? { query: change.query } : {}),
      });
    },
    toString() {
      return `${parts.scheme}://${encodeURI(parts.path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
    },
  };
}

export const stub = {
  config: new Map<string, unknown>(),
  remoteName: undefined as string | undefined,
  workspaceFolders: undefined as { uri: StubUri; name: string }[] | undefined,
  commands: [] as RecordedCommand[],
  warnings: [] as string[],
  infos: [] as string[],
  errors: [] as string[],
  /** Every warning call with its options (modal/detail) — what a modal SHOWED. */
  warningCalls: [] as RecordedMessage[],
  /** Every error call with the buttons it offered. */
  errorCalls: [] as RecordedMessage[],
  /**
   * Buttons the TEST clicks by hand: a prompt offering one of these labels
   * stays open until the test calls `clicks.shift()?.(label)`.
   */
  manual: new Set<string>(),
  clicks: [] as ((value: string | undefined) => void)[],
  /** Next answers for modal prompts, by button label the code offers. */
  answers: new Map<string, string | undefined>(),
  /** Next answers of `showInputBox`, in order (`undefined` = Escape). */
  inputs: [] as (string | undefined)[],
  /** Every `showInputBox` call with its options (incl. `validateInput`). */
  inputCalls: [] as InputBoxCall[],
  /** Answer of `showSaveDialog` (`undefined` = cancelled). */
  saveUri: undefined as StubUri | undefined,
  /** Every `showSaveDialog` call with its options. */
  saveCalls: [] as SaveDialogCall[],
  /** Every `workspace.fs.writeFile` call. */
  fileWrites: [] as { uri: StubUri; bytes: Uint8Array }[],
  /** When set, `workspace.fs.writeFile` rejects with it. */
  writeError: null as Error | null,
  /** Quick picks shown (items + options); `pickIndex` chooses one (undefined = dismissed). */
  quickPickCalls: [] as {
    items: { label: string; description?: string; detail?: string; kind?: number; picked?: boolean }[];
    options: unknown;
  }[],
  pickIndex: undefined as number | undefined,
  /** For `canPickMany` pickers: the item indexes the user checks (undefined = dismissed). */
  pickIndexes: undefined as number[] | undefined,
  /** Content providers registered per scheme. */
  contentProviders: new Map<string, { provideTextDocumentContent(uri: StubUri): string | undefined }>(),
  /** Virtual documents opened / language set / shown (A5 patch view). */
  openedDocuments: [] as StubTextDocument[],
  languageChanges: [] as { uri: StubUri; languageId: string }[],
  shownDocuments: [] as { document: StubTextDocument; options: unknown }[],
  reset(): void {
    this.config.clear();
    this.remoteName = undefined;
    this.workspaceFolders = undefined;
    this.commands.length = 0;
    this.warnings.length = 0;
    this.infos.length = 0;
    this.errors.length = 0;
    this.warningCalls.length = 0;
    this.errorCalls.length = 0;
    this.answers.clear();
    this.manual.clear();
    this.clicks.length = 0;
    this.inputs.length = 0;
    this.inputCalls.length = 0;
    this.saveUri = undefined;
    this.saveCalls.length = 0;
    this.fileWrites.length = 0;
    this.writeError = null;
    this.quickPickCalls.length = 0;
    this.pickIndex = undefined;
    this.pickIndexes = undefined;
    this.contentProviders.clear();
    this.openedDocuments.length = 0;
    this.languageChanges.length = 0;
    this.shownDocuments.length = 0;
  },
};

export interface StubTextDocument {
  uri: StubUri;
  languageId: string;
}

export interface InputBoxCall {
  title?: string;
  prompt?: string;
  value?: string;
  validateInput?: (value: string) => string | undefined | null;
}

export interface SaveDialogCall {
  defaultUri?: StubUri;
  filters?: Record<string, string[]>;
  saveLabel?: string;
  title?: string;
}

function answer(items: unknown[]): Promise<string | undefined> {
  if (items.some((item) => typeof item === 'string' && stub.manual.has(item))) {
    return new Promise((resolve) => stub.clicks.push(resolve));
  }
  for (const item of items) {
    if (typeof item === 'string' && stub.answers.has(item)) return Promise.resolve(stub.answers.get(item));
  }
  return Promise.resolve(undefined);
}

export const Uri = {
  file: (fsPath: string): StubUri => makeUri({ scheme: 'file', path: fsPath, query: '', fragment: '' }),
  from: (parts: { scheme: string; path?: string; query?: string; fragment?: string }): StubUri =>
    makeUri({ scheme: parts.scheme, path: parts.path ?? '', query: parts.query ?? '', fragment: parts.fragment ?? '' }),
};

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    this.fn();
  }
}

export const env = {
  get remoteName(): string | undefined {
    return stub.remoteName;
  },
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T): T => (stub.config.has(key) ? (stub.config.get(key) as T) : fallback),
  }),
  get workspaceFolders() {
    return stub.workspaceFolders;
  },
  registerTextDocumentContentProvider: (
    scheme: string,
    provider: { provideTextDocumentContent(uri: StubUri): string | undefined },
  ) => {
    stub.contentProviders.set(scheme, provider);
    return new Disposable(() => stub.contentProviders.delete(scheme));
  },
  openTextDocument: (uri: StubUri): Promise<StubTextDocument> => {
    const document = { uri, languageId: uri.path.endsWith('.diff') ? 'diff' : 'plaintext' };
    stub.openedDocuments.push(document);
    return Promise.resolve(document);
  },
  fs: {
    writeFile: (uri: StubUri, bytes: Uint8Array): Promise<void> => {
      if (stub.writeError) return Promise.reject(stub.writeError);
      stub.fileWrites.push({ uri, bytes });
      return Promise.resolve();
    },
  },
};

export const window = {
  activeTextEditor: undefined,
  showWarningMessage: (message: string, ...items: unknown[]) => {
    stub.warnings.push(message);
    const first = items[0];
    const options =
      first !== null && typeof first === 'object' ? (first as RecordedMessage['options']) : undefined;
    stub.warningCalls.push({
      message,
      options,
      items: items.filter((item): item is string => typeof item === 'string'),
    });
    return answer(items);
  },
  showInformationMessage: (message: string, ...items: unknown[]) => {
    stub.infos.push(message);
    return answer(items);
  },
  showInputBox: (options: InputBoxCall) => {
    stub.inputCalls.push(options);
    return Promise.resolve(stub.inputs.shift());
  },
  showSaveDialog: (options: SaveDialogCall) => {
    stub.saveCalls.push(options);
    return Promise.resolve(stub.saveUri);
  },
  showQuickPick: <T extends { label: string; kind?: number }>(items: T[], options?: { canPickMany?: boolean }): Promise<T | T[] | undefined> => {
    stub.quickPickCalls.push({ items, options });
    if (options?.canPickMany === true) {
      if (stub.pickIndexes === undefined) return Promise.resolve(undefined);
      // Like VS Code: a separator row can never be checked.
      return Promise.resolve(
        stub.pickIndexes
          .map((i) => items[i])
          .filter((item): item is T => item !== undefined && item.kind !== QuickPickItemKind.Separator),
      );
    }
    return Promise.resolve(stub.pickIndex === undefined ? undefined : items[stub.pickIndex]);
  },
  showTextDocument: (document: StubTextDocument, options?: unknown) => {
    stub.shownDocuments.push({ document, options });
    return Promise.resolve({ document });
  },
  showErrorMessage: (message: string, ...items: unknown[]) => {
    stub.errors.push(message);
    stub.errorCalls.push({
      message,
      options: undefined,
      items: items.filter((item): item is string => typeof item === 'string'),
    });
    return answer(items);
  },
};

/** `vscode.QuickPickItemKind` (Separator = -1, Default = 0). */
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;

export const commands = {
  executeCommand: (command: string, ...args: unknown[]) => {
    stub.commands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export const languages = {
  getDiagnostics: () => [],
  setTextDocumentLanguage: (document: StubTextDocument, languageId: string): Promise<StubTextDocument> => {
    stub.languageChanges.push({ uri: document.uri, languageId });
    return Promise.resolve({ ...document, languageId });
  },
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
