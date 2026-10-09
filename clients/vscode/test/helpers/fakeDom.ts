/**
 * A deliberately small DOM stand-in for running the real `src/webview/app.ts`
 * under `node:vm` (no jsdom/happy-dom dependency). It implements only the
 * surface the sidebar uses, with the browser's semantics for it:
 * element identity, `textContent` (text only, never HTML parsing),
 * `replaceChildren`, form values, focus and click listeners.
 *
 * It is a test double for the BROWSER, not for the unit under test: the
 * sidebar script itself is transpiled from source and executed unmodified.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import * as ts from 'typescript';

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  data?: unknown;
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  preventDefault(): void;
}

export class FakeNode {
  parentNode: FakeElement | null = null;
}

export class FakeText extends FakeNode {
  constructor(public data: string) {
    super();
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly childNodes: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  id = '';
  className = '';
  type = '';
  rows = 0;
  placeholder = '';
  checked = false;
  selected = false;
  disabled = false;
  private rawValue = '';

  constructor(
    readonly ownerDocument: FakeDocument,
    tag: string,
  ) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  get textContent(): string {
    return this.childNodes.map((n) => (n instanceof FakeText ? n.data : n.textContent)).join('');
  }

  set textContent(value: string) {
    this.detachAll();
    if (value !== '') this.adopt(new FakeText(String(value)));
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      const options = this.children.filter((c) => c.tagName === 'OPTION');
      const chosen = options.find((o) => o.selected) ?? options[0];
      return chosen ? chosen.value : '';
    }
    return this.rawValue;
  }

  set value(next: string) {
    if (this.tagName === 'SELECT') {
      for (const option of this.children) option.selected = option.value === next;
      return;
    }
    this.rawValue = String(next);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.adopt(child);
    return child;
  }

  replaceChildren(...nodes: (FakeElement | FakeText)[]): void {
    this.detachAll();
    for (const node of nodes) this.adopt(node);
  }

  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string, init: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = { type, preventDefault: () => undefined, ...init };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    // Like a browser: a disabled control does not fire click.
    if (this.disabled) return;
    this.dispatch('click');
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /** Test helper: depth-first search. */
  find(predicate: (el: FakeElement) => boolean): FakeElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const deeper = child.find(predicate);
      if (deeper) return deeper;
    }
    return null;
  }

  findAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    return this.children.flatMap((c) => [...(predicate(c) ? [c] : []), ...c.findAll(predicate)]);
  }

  private adopt(node: FakeElement | FakeText): void {
    if (node.parentNode) {
      const siblings = node.parentNode.childNodes;
      siblings.splice(siblings.indexOf(node), 1);
    }
    node.parentNode = this;
    this.childNodes.push(node);
  }

  private detachAll(): void {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes.length = 0;
    if (this.ownerDocument.activeElement && !this.ownerDocument.body.contains(this.ownerDocument.activeElement)) {
      // Like a browser: a removed focused element loses focus to <body>.
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
}

export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }

  getElementById(id: string): FakeElement | null {
    return this.body.find((el) => el.id === id);
  }
}

export interface SidebarHarness {
  document: FakeDocument;
  root: FakeElement;
  announcer: FakeElement;
  posted: unknown[];
  /** Deliver a `{type:'state'}` message as the extension host would. */
  push(state: unknown): void;
  /** Run the pending animation-frame callbacks; returns how many ran. */
  flushFrame(): number;
  rafRequests(): number;
  byId(id: string): FakeElement;
}

/** Transpile and run the real sidebar script against a fresh fake DOM. */
export function loadSidebar(): SidebarHarness {
  const document = new FakeDocument();
  const root = document.createElement('div');
  root.id = 'sandpane-root';
  const announcer = document.createElement('div');
  announcer.id = 'sp-announcer';
  document.body.appendChild(root);
  document.body.appendChild(announcer);

  const posted: unknown[] = [];
  const windowListeners: Listener[] = [];
  let frames: (() => void)[] = [];
  let rafCount = 0;
  const fakeWindow = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') windowListeners.push(listener);
    },
    requestAnimationFrame: (cb: () => void) => {
      rafCount += 1;
      frames.push(cb);
      return rafCount;
    },
  };

  const source = readFileSync(join(__dirname, '..', '..', 'src', 'webview', 'app.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  const context = createContext({
    window: fakeWindow,
    document,
    HTMLElement: FakeElement,
    acquireVsCodeApi: () => ({
      postMessage: (message: unknown) => posted.push(message),
      getState: () => undefined,
      setState: () => undefined,
    }),
    JSON,
  });
  runInContext(outputText, context, { filename: 'app.js' });

  return {
    document,
    root,
    announcer,
    posted,
    push(state: unknown) {
      const event: FakeEvent = { type: 'message', data: { type: 'state', state }, preventDefault: () => undefined };
      for (const listener of windowListeners) listener(event);
    },
    flushFrame() {
      const pending = frames;
      frames = [];
      for (const cb of pending) cb();
      return pending.length;
    },
    rafRequests: () => rafCount,
    byId(id: string) {
      const found = document.getElementById(id);
      if (!found) throw new Error(`no element #${id}`);
      return found;
    },
  };
}
