import { displayError } from "../i18n/errors";
import { useI18n } from "../i18n";
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
      <ErrorFallback error={this.state.error} />
    ) : (
      this.props.children
    );
  }
}

function ErrorFallback({ error }: { error: Error }) {
  const { t, label } = useI18n();
  return <div className="empty"><h1>{t("ui.somethingWentWrong")}</h1><p>{displayError(error, t, label)}</p><button className="button" onClick={() => window.location.reload()}>{t("ui.reloadWorkspace")}
  </button></div>;
}
