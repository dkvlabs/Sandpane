/**
 * The transport used when the UI is NOT inside a Tauri window (plain `vite`
 * browser dev, or a shell where the IPC bridge failed to load).
 *
 * It has exactly one job: make "we cannot reach Core" a real, typed state
 * instead of a fake-success screen (docs/specs/05 §5). Every write rejects;
 * nothing is ever simulated.
 */

import type { CoreTransport } from "../lib/core-client";

export class UnavailableTransport implements CoreTransport {
  readonly kind = "unavailable";

  constructor(private readonly reason: string) {}

  write(_frame: string): Promise<void> {
    return Promise.reject(new Error(this.reason));
  }

  onLine(_handler: (line: string) => void): () => void {
    return () => {};
  }

  onClose(handler: (reason: string) => void): () => void {
    // Report once, asynchronously, so the subscriber is already installed.
    const timer = setTimeout(() => handler(this.reason), 0);
    return () => clearTimeout(timer);
  }

  close(): void {}
}

export function isTauriWindow(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as unknown as Record<string, unknown>)[
    "__TAURI_INTERNALS__"
  ];
  const event = (window as unknown as Record<string, unknown>)[
    "__TAURI_EVENT__"
  ];
  return internals !== undefined || event !== undefined;
}
