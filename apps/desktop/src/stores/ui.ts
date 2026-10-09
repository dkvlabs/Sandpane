/**
 * UI-only state.
 *
 * The spec allows Zustand here; this scaffold keeps the dependency count at zero
 * by exposing the same `get/set/subscribe` shape over a plain object. Swapping in
 * Zustand later is mechanical. Nothing Core owns is stored here: no projects, no
 * tasks, no transcripts — only presentation preferences and selection, per
 * docs/specs/05 §2 ("persist only UI selection locally").
 *
 * Persistence is `localStorage` inside the webview. A native per-app config
 * store (Tauri plugin) is the DT1 target; this is labelled as UI preference
 * storage in the Settings view rather than claimed as a Core setting.
 */

export type ThemePreference = "system" | "dark" | "light";
export type DensityPreference = "comfortable" | "compact";

export interface UiState {
  theme: ThemePreference;
  density: DensityPreference;
  reducedMotionOverride: boolean;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  /** Last project the user opened in this window (selection only, not state). */
  lastProjectId: string | null;
  /** Bounds the rendered timeline; the rest stays in Core. */
  maxVisibleEvents: number;
  /** Streaming notification coalescing window (ms). */
  eventBatchMs: number;
  /** Privacy/behaviour toggles that are genuinely local to the UI. */
  confirmDestructiveActions: boolean;
  nativeNotifications: boolean;
}

const DEFAULTS: UiState = {
  theme: "system",
  density: "comfortable",
  reducedMotionOverride: false,
  sidebarCollapsed: false,
  inspectorOpen: false,
  lastProjectId: null,
  maxVisibleEvents: 200,
  eventBatchMs: 80,
  confirmDestructiveActions: true,
  nativeNotifications: false,
};

const STORAGE_KEY = "sandpane.desktop.ui";

function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Some webview configurations throw on access.
    return null;
  }
}

const listeners = new Set<() => void>();

let state: UiState = { ...DEFAULTS };

export const uiPreferences = {
  get(): UiState {
    return state;
  },
  set(patch: Partial<UiState>): void {
    state = { ...state, ...patch };
    persist();
    for (const listener of [...listeners]) listener();
  },
  reset(): void {
    state = { ...DEFAULTS };
    persist();
    for (const listener of [...listeners]) listener();
  },
};

export function subscribeUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function loadUiPreferences(): void {
  const storage = safeStorage();
  if (!storage) return;
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<UiState>;
    state = { ...DEFAULTS, ...sanitize(parsed) };
  } catch {
    // Corrupt payload: fall back to defaults rather than guessing.
    state = { ...DEFAULTS };
  }
}

function sanitize(parsed: Partial<UiState>): Partial<UiState> {
  const out: Partial<UiState> = {};
  if (parsed.theme === "system" || parsed.theme === "dark" || parsed.theme === "light") {
    out.theme = parsed.theme;
  }
  if (parsed.density === "comfortable" || parsed.density === "compact") {
    out.density = parsed.density;
  }
  const booleans: (keyof UiState)[] = [
    "reducedMotionOverride",
    "sidebarCollapsed",
    "inspectorOpen",
    "confirmDestructiveActions",
    "nativeNotifications",
  ];
  for (const key of booleans) {
    if (typeof parsed[key] === "boolean") {
      (out as Record<string, unknown>)[key] = parsed[key];
    }
  }
  if (typeof parsed.lastProjectId === "string") out.lastProjectId = parsed.lastProjectId;
  if (typeof parsed.maxVisibleEvents === "number") {
    out.maxVisibleEvents = clamp(parsed.maxVisibleEvents, 25, 1000);
  }
  if (typeof parsed.eventBatchMs === "number") {
    out.eventBatchMs = clamp(parsed.eventBatchMs, 16, 500);
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function persist(): void {
  const storage = safeStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Applies theme/density/motion to the document element (design spec §4.5, §10). */
export function applyUiTheme(next: UiState): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved =
    next.theme === "system"
      ? window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : next.theme;
  root.dataset.theme = resolved;
  root.dataset.density = next.density;
  root.dataset.reducedMotion = next.reducedMotionOverride ? "force" : "auto";
}
