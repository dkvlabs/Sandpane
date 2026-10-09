/**
 * Minimal stand-in for the `vscode` module, aliased in vitest.config.ts so
 * `src/session.ts` (vscode glue) can run under plain Node. It covers only the
 * API surface the session touches, records every side effect, and lets a test
 * script modal answers. It is a test double for VS Code, not for the session.
 */

export interface RecordedCommand {
  command: string;
  args: unknown[];
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
  /** Next answers for modal prompts, by button label the code offers. */
  answers: new Map<string, string | undefined>(),
  reset(): void {
    this.config.clear();
    this.remoteName = undefined;
    this.workspaceFolders = undefined;
    this.commands.length = 0;
    this.warnings.length = 0;
    this.infos.length = 0;
    this.errors.length = 0;
    this.answers.clear();
  },
};

function answer(items: unknown[]): Promise<string | undefined> {
  for (const item of items) {
    if (typeof item === 'string' && stub.answers.has(item)) return Promise.resolve(stub.answers.get(item));
  }
  return Promise.resolve(undefined);
}

export const Uri = {
  file: (fsPath: string): StubUri => makeUri({ scheme: 'file', path: fsPath, query: '', fragment: '' }),
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
};

export const window = {
  activeTextEditor: undefined,
  showWarningMessage: (message: string, ...items: unknown[]) => {
    stub.warnings.push(message);
    return answer(items);
  },
  showInformationMessage: (message: string, ...items: unknown[]) => {
    stub.infos.push(message);
    return answer(items);
  },
  showErrorMessage: (message: string, ...items: unknown[]) => {
    stub.errors.push(message);
    return answer(items);
  },
};

export const commands = {
  executeCommand: (command: string, ...args: unknown[]) => {
    stub.commands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export const languages = {
  getDiagnostics: () => [],
};

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
