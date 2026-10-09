/**
 * Tauri IPC transport.
 *
 * The webview never touches a socket, a path or a process. It calls exactly one
 * narrow Rust command — `core_request_frame` — which validates the frame against
 * the allowlisted `sandpane_protocol::Method` set and the `MAX_FRAME_BYTES` cap
 * before proxying it to the per-user Core socket (docs/specs/05 §1: Tauri is a
 * narrow typed client, not a second Core and not a shell).
 *
 * Framing, id correlation and `afterSequence` replay stay in TypeScript
 * (`src/lib/core-client.ts`), so the identical wire code path is exercised by
 * the unit tests against an in-memory duplex.
 */

import { decodeProxyRejection, type CoreTransport } from "../lib/core-client";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const CORE_REQUEST_FRAME_COMMAND = "core_request_frame";

export class TauriTransport implements CoreTransport {
  readonly kind = "tauri";
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private closed = false;

  constructor(private readonly invoke: Invoke) {}

  write(frame: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("transport already closed"));
    return this.invoke(CORE_REQUEST_FRAME_COMMAND, { line: frame }).then(
      (reply) => {
        if (typeof reply !== "string") return;
        const line = reply.endsWith("\n") ? reply.slice(0, -1) : reply;
        if (line.length === 0) return;
        for (const handler of [...this.lineHandlers]) handler(line);
      },
      // The proxy rejects with its serialized `ProxyError` object
      // ({code, message, mayHaveBeenApplied}); keep it structured.
      (err: unknown) => {
        throw decodeProxyRejection(err);
      },
    );
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.lineHandlers.clear();
    for (const handler of [...this.closeHandlers]) {
      handler("the desktop released its Core socket handle");
    }
    this.closeHandlers.clear();
  }
}

/**
 * Resolve the transport for the current runtime. Returns `null` outside a Tauri
 * window so the caller can build an explicit unavailable state — never a stub
 * that answers with invented data.
 */
export async function createTauriTransport(): Promise<TauriTransport | null> {
  const internals = (globalThis as unknown as Record<string, unknown>)[
    "__TAURI_INTERNALS__"
  ];
  if (internals === undefined) return null;
  const core = await import("@tauri-apps/api/core");
  return new TauriTransport(core.invoke as Invoke);
}
