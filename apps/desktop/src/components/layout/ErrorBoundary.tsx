import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/primitives";

/**
 * Last-resort render guard. A view that throws must not leave a blank window:
 * the user sees what failed and two actions that work without the failed view.
 * It never claims anything about Core — the failure is in this window's render.
 *
 * `resetKey` (the route hash) clears the error on navigation, so leaving the
 * broken view recovers without a reload.
 */
export class ErrorBoundary extends Component<
  { resetKey: string; children: ReactNode },
  { error: Error | null; key: string }
> {
  constructor(props: { resetKey: string; children: ReactNode }) {
    super(props);
    this.state = { error: null, key: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: Error | null; key: string },
  ): { error: Error | null; key: string } | null {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local diagnostics only; nothing leaves the machine.
    console.error("Sandpane view failed to render", error, info.componentStack);
  }

  /**
   * Clear the error explicitly as well as navigating: when the failed view IS
   * the dashboard, the hash does not change and `resetKey` alone would never
   * reset the boundary.
   */
  private readonly goToDashboard = (): void => {
    if (window.location.hash !== "#/") window.location.hash = "#/";
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h1 className="fatal__title">This view failed to render</h1>
        <p className="muted">
          The desktop hit an error while drawing this screen. Core and its tasks are unaffected —
          a window error never cancels work.
        </p>
        <pre className="fatal__detail">{error.message}</pre>
        <div className="row-actions">
          <Button variant="primary" onClick={this.goToDashboard}>
            Go to Dashboard
          </Button>
          <Button onClick={() => window.location.reload()}>Reload window</Button>
        </div>
      </div>
    );
  }
}
