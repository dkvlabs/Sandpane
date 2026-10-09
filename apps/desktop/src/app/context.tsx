import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreClient, type CoreTransport } from "../lib/core-client";
import { TaskEventStore } from "../lib/event-store";
import type { AppDeps } from "../lib/hooks";
import { loadUiPreferences, subscribeUi, uiPreferences } from "../stores/ui";

/**
 * Build the single set of app dependencies from a transport.
 *
 * The transport is decided in `main.tsx` *before* React renders: either the
 * Tauri IPC proxy (a real socket path) or an explicit unavailable transport.
 * There is no third option — the app never quietly substitutes a stub that
 * answers with invented data (docs/specs/05 §5).
 */
export function buildDeps(
  transport: CoreTransport,
  options: { transportReason?: string | null } = {},
): AppDeps {
  const client = new CoreClient(transport);
  const store = new TaskEventStore(client);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  return {
    client,
    store,
    queryClient,
    transportAvailable: transport.kind === "tauri",
    transportKind: transport.kind,
    transportReason: options.transportReason ?? null,
  };
}

const DepsContext = createContext<AppDeps | null>(null);

export function CoreProvider({
  deps,
  children,
}: {
  deps: AppDeps;
  children: ReactNode;
}) {
  useEffect(() => {
    // One global replay stream per window; detached on unmount so a closed UI
    // never leaves a subscription running (specs/05 §11 performance contract).
    // The client itself is NOT closed here: StrictMode remounts and a UI detach
    // must never cancel Core work.
    deps.store.start();
    return () => {
      deps.store.stop();
    };
  }, [deps]);

  return (
    <DepsContext.Provider value={deps}>
      <QueryClientProvider client={deps.queryClient}>
        {children}
      </QueryClientProvider>
    </DepsContext.Provider>
  );
}

export function useDeps(): AppDeps {
  const deps = useContext(DepsContext);
  if (deps === null) {
    throw new Error("useDeps must be used inside <CoreProvider>");
  }
  return deps;
}

/** UI-only preferences (theme, density, sidebar). Never Core state. */
export function useUiPreferences() {
  const [state, setState] = useState(() => {
    loadUiPreferences();
    return uiPreferences.get();
  });
  useEffect(
    () =>
      subscribeUi(() => {
        setState(uiPreferences.get());
      }),
    [],
  );
  return {
    preferences: state,
    set: (patch: Partial<typeof state>) => uiPreferences.set(patch),
  };
}
