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
  /** Streaming notification coalescing window (ms); drives `TaskEventStore`. */
  eventBatchMs: number;
  /**
   * Stored preference only (no notification command yet). There is deliberately
   * NO toggle for destructive-action confirmation: confirmation is mandatory
   * (docs/specs/05 §5), so it is not a preference.
   */
  nativeNotifications: boolean;
}

const DEFAULTS: UiState = {
  theme: "system",
  density: "comfortable",
  reducedMotionOverride: false,
  // Design spec §3: an icon-only rail (56 px) with tooltips by default;
  // labelled navigation is the opt-in expanded form.
  sidebarCollapsed: true,
  inspectorOpen: false,
  lastProjectId: null,
  maxVisibleEvents: 200,
  eventBatchMs: 80,
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
    // The same bounds as a persisted payload: an out-of-range number typed in
    // Settings never reaches the event store or the timeline.
    state = { ...state, ...sanitize({ ...state, ...patch }) };
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
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Partial<UiState>;
    state = { ...DEFAULTS, ...sanitize(parsed) };
  } catch {
    // Corrupt payload: fall back to defaults rather than guessing.
    state = { ...DEFAULTS };
  }
}

/** Exported for tests: what survives from a persisted or patched payload. */
export function sanitize(parsed: Partial<UiState>): Partial<UiState> {
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
    "nativeNotifications",
  ];
  for (const key of booleans) {
    if (typeof parsed[key] === "boolean") {
      (out as Record<string, unknown>)[key] = parsed[key];
    }
  }
  if (typeof parsed.lastProjectId === "string" || parsed.lastProjectId === null) {
    out.lastProjectId = parsed.lastProjectId;
  }
  if (typeof parsed.maxVisibleEvents === "number" && Number.isFinite(parsed.maxVisibleEvents)) {
    out.maxVisibleEvents = clamp(parsed.maxVisibleEvents, 25, 1000);
  }
  if (typeof parsed.eventBatchMs === "number" && Number.isFinite(parsed.eventBatchMs)) {
    out.eventBatchMs = clamp(parsed.eventBatchMs, EVENT_BATCH_MS_MIN, EVENT_BATCH_MS_MAX);
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function persist(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded or storage blocked: the preference still applies for this
    // session; failing to persist a UI preference must never break the app.
  }
}

/** Bounds for the coalescing window, shared with `TaskEventStore.setBatchMs`. */
export const EVENT_BATCH_MS_MIN = 16;
export const EVENT_BATCH_MS_MAX = 500;

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

/**
 * While the theme is "system", re-apply on OS light/dark changes. Returns the
 * unsubscribe; a no-op for an explicit theme or where `matchMedia` is absent.
 */
export function watchSystemTheme(next: UiState, onChange: () => void): () => void {
  if (next.theme !== "system" || typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const query = window.matchMedia("(prefers-color-scheme: light)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
