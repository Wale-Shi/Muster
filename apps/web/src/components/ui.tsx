import { displayError } from "../i18n/errors";
import { useI18n } from "../i18n";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { TodoPhase } from "@muster/shared";
import { initials } from "../lib/format";

export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${small ? "small" : ""}`} title={name}>
      {initials(name)}
    </span>
  );
}
export function PhaseDot({ phase }: { phase: TodoPhase }) {
  const { label } = useI18n();
  return ["planning", "building", "queued"].includes(phase) ? (
    <LoaderCircle
      size={12}
      className={`phase-icon ${phase} spin`}
      aria-label={label("phase", phase)}
    />
  ) : (
    <span className={`phase-dot ${phase}`} title={label("phase", phase)} />
  );
}
export function PhaseBadge({ phase }: { phase: TodoPhase }) {
  const { label } = useI18n();
  return (
    <span className={`badge phase-badge ${phase}`}>
      <PhaseDot phase={phase} />
      {label("phase", phase)}
    </span>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  const { t, label } = useI18n();
  return error ? (
    <div className="error" role="alert">
      {displayError(error, t, label)}
    </div>
  ) : null;
}
export function Loading() {
  const { t } = useI18n();
  return (
    <div className="centered muted">
      <LoaderCircle className="spin" size={18} />
      <span>{t("ui.loading")}</span>
    </div>
  );
}
export function Empty({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    dialog
      ?.querySelector<HTMLElement>(
        '[autofocus], input:not([type="checkbox"]), textarea',
      )
      ?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "wide" : ""}`}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label={t("ui.closeDialog")}
        >
          <X size={16} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
