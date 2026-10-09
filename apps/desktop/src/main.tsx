import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { buildDeps } from "./app/context";
import { createTauriTransport } from "./transport/tauri";
import { UnavailableTransport, isTauriWindow } from "./transport/unavailable";
import { applyUiTheme, loadUiPreferences, uiPreferences } from "./stores/ui";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/motion.css";

/**
 * Entry point.
 *
 * The transport decision happens before React renders, so the first paint is
 * already either "attached to Core" or an explicit unavailable state — there is
 * no optimistic success frame (docs/specs/05 §5).
 */
async function main() {
  loadUiPreferences();
  // Set before first paint so the theme does not flash.
  applyUiTheme(uiPreferences.get());

  const tauri = isTauriWindow() ? await createTauriTransport() : null;
  const reason =
    tauri !== null
      ? null
      : isTauriWindow()
        ? "a Tauri window was detected but the IPC bridge could not be loaded"
        : "this window is not running inside the Tauri shell, so it cannot reach the per-user Core socket";
  const transport = tauri ?? new UnavailableTransport(reason ?? "no transport");

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("index.html is missing #root");
  }
  createRoot(container).render(
    <StrictMode>
      <App deps={buildDeps(transport, { transportReason: reason })} />
    </StrictMode>,
  );
}

void main();
