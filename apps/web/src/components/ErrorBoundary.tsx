import { Component, type ErrorInfo, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Muster UI error", error, info.componentStack);
  }
  override render() {
    return this.state.error ? (
      <div className="empty">
        <h1>Something went wrong</h1>
        <p>{this.state.error.message}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
