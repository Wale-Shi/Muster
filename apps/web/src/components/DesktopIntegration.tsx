import { useEffect } from "react";
import { useNavigate } from "react-router";

export function DesktopIntegration({ onNewTask, onShortcuts }: { onNewTask: () => void; onShortcuts?: () => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    const unsubscribe = window.muster?.onCommand((command) => {
      if (command.type === "fullscreen") document.documentElement.classList.toggle("muster-fullscreen", command.fullscreen);
      else if (command.type === "settings") navigate("/settings");
      else if (command.type === "shortcuts") onShortcuts?.();
      else if (command.type === "new-task") onNewTask();
      else if (command.type === "open-todo") navigate(`/todos/${encodeURIComponent(command.id)}`);
    });
    return () => {
      unsubscribe?.();
      document.documentElement.classList.remove("muster-fullscreen");
    };
  }, [navigate, onNewTask, onShortcuts]);
  return null;
}
