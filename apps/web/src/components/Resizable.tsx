import { useI18n } from "../i18n";
import { useRef, type ReactNode } from "react";
import { useStored } from "../hooks/usePreferences";

export function Resizable({
  left,
  right,
  storageKey,
  initial = 46,
  hidden = false,
  maximized = false,
  mobileSide = "left",
  onSwipe,
}: {
  left: ReactNode;
  right: ReactNode;
  storageKey: string;
  initial?: number;
  hidden?: boolean;
  maximized?: boolean;
  mobileSide?: "left" | "right";
  onSwipe?: (side: "left" | "right") => void;
}) {
  const { t } = useI18n();
  const [width, setWidth] = useStored(storageKey, initial);
  const container = useRef<HTMLDivElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const clamp = (value: number) => Math.max(24, Math.min(76, value));
  return (
    <div
      ref={container}
      className={`split ${hidden ? "right-hidden" : ""} ${maximized ? "right-maximized" : ""} mobile-${mobileSide}`}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
      }}
      onTouchEnd={(event) => {
        const touch = event.changedTouches[0];
        const start = touchStart.current;
        if (
          !touch ||
          !start ||
          (event.target instanceof HTMLElement &&
            event.target.closest("textarea, input, pre, button, .board-columns"))
        )
          return;
        if (
          Math.abs(touch.clientX - start.x) > 90 &&
          Math.abs(touch.clientY - start.y) < 60
        )
          onSwipe?.(touch.clientX < start.x ? "right" : "left");
      }}
    >
      <section className="split-left" style={{ width: `${clamp(width)}%` }}>
        {left}
      </section>
      <div
        className="resize-handle"
        role="separator"
        aria-label={t("ui.resizePanels")}
        aria-orientation="vertical"
        aria-valuenow={Math.round(clamp(width))}
        aria-valuemin={24}
        aria-valuemax={76}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setWidth(clamp(width + (event.key === "ArrowLeft" ? -2 : 2)));
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (
            !event.currentTarget.hasPointerCapture(event.pointerId) ||
            !container.current
          )
            return;
          const rect = container.current.getBoundingClientRect();
          setWidth(clamp(((event.clientX - rect.left) / rect.width) * 100));
        }}
        onPointerUp={(event) =>
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      />
      <section className="split-right">{right}</section>
    </div>
  );
}
