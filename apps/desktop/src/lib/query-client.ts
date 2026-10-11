/**
 * The app's single QueryClient.
 *
 * `networkMode: "always"` for EVERY query and mutation (A6 review D-C1): Core
 * is local IPC through the Tauri proxy, so the browser's online/offline state
 * says nothing about whether Core is reachable. With TanStack's default
 * (`"online"`), a mutation confirmed while the webview believed it was offline
 * would pause before `mutationFn` ran and be sent LATER by itself on an
 * `online` event — a confirmed `git.apply` (or any other write) firing long
 * after the user's gesture, even after a task switch. "always" runs it now or
 * fails it now; Core's own reachability is reported by the transport.
 */

import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, networkMode: "always" },
      mutations: { networkMode: "always" },
    },
  });
}
