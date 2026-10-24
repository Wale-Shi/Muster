import { useEffect } from "react";
import { useNavigate } from "react-router";

export function DesktopIntegration({ onNewTask }: { onNewTask: () => void }) {
  const navigate = useNavigate();
  useEffect(() => window.muster?.onCommand((command) => {
    if (command.type === "new-task") onNewTask();
    else if (command.type === "open-todo") navigate(`/todos/${encodeURIComponent(command.id)}`);
  }), [navigate, onNewTask]);
  return null;
}
