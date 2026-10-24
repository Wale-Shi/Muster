import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  FileText,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import { api, type TodoAction, type TodoDetail } from "../api/client";
import { isRunning } from "../lib/board";
import { Dialog, ErrorNotice } from "./ui";

export function TodoActions({
  todo,
  onDone,
}: {
  todo: TodoDetail;
  onDone: () => void;
}) {
  const [menu, setMenu] = useState<"start" | "rerun" | null>(null);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({
      action,
      input,
    }: {
      action: TodoAction;
      input?: Parameters<typeof api.action>[2];
    }) => api.action(todo.id, action, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["todos"] });
      void client.invalidateQueries({ queryKey: ["todo", todo.id] });
      setMenu(null);
    },
  });
  const run = (action: TodoAction, input?: Parameters<typeof api.action>[2]) =>
    mutation.mutate({ action, ...(input ? { input } : {}) });
  const pending = mutation.isPending;
  return (
    <>
      <div className="todo-actions">
        {todo.phase === "todo" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={() => setMenu("start")}
          >
            <Play size={13} />
            Start
            <ChevronDown size={12} />
          </button>
        )}
        {todo.phase === "confirm" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={() => run("confirm")}
          >
            <Check size={14} />
            Confirm plan
          </button>
        )}
        {todo.phase === "review" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={onDone}
          >
            <Check size={14} />
            Done
          </button>
        )}
        {todo.phase === "failed" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={() => setMenu("rerun")}
          >
            <RotateCcw size={13} />
            Rerun
            <ChevronDown size={12} />
          </button>
        )}
        {isRunning(todo.phase) && (
          <button
            className="button"
            disabled={
              pending || todo.builds.at(-1)?.turns.at(-1)?.status !== "running"
            }
            onClick={() => run("stop")}
            title="Request a cooperative stop"
          >
            <Pause size={13} />
            Stop
          </button>
        )}
        {["done", "closed"].includes(todo.phase) ? (
          <button
            className="button"
            disabled={pending}
            onClick={() => run("reopen")}
          >
            <RotateCcw size={13} />
            Reopen
          </button>
        ) : (
          <button
            className="button ghost"
            disabled={pending}
            onClick={() => run("close")}
          >
            <X size={13} />
            Close
          </button>
        )}
        {pending && <span className="hint">Updating…</span>}
      </div>
      <ErrorNotice error={menu ? null : mutation.error} />
      {menu && (
        <Dialog
          title={menu === "start" ? "Start task" : "Rerun task"}
          onClose={() => setMenu(null)}
        >
          <div className="dialog-body form-stack">
            <p className="muted">
              {menu === "start"
                ? "Choose how your agent should approach this task."
                : "Continue the existing build or begin a fresh build."}
            </p>
            <ErrorNotice error={mutation.error} />
            {menu === "start" ? (
              <>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("start", { mode: "plan" })}
                >
                  <FileText size={18} />
                  <span>
                    <strong>Plan first</strong>
                    <small>Review a plan before the agent writes code.</small>
                  </span>
                </button>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("start", { mode: "run" })}
                >
                  <Play size={18} />
                  <span>
                    <strong>Run now</strong>
                    <small>Start building right away.</small>
                  </span>
                </button>
              </>
            ) : (
              <>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("rerun", { strategy: "continue" })}
                >
                  <Play size={18} />
                  <span>
                    <strong>Continue</strong>
                    <small>Keep the existing worktree and session.</small>
                  </span>
                </button>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("rerun", { strategy: "restart" })}
                >
                  <RotateCcw size={18} />
                  <span>
                    <strong>Start over</strong>
                    <small>Create a new build with a fresh session.</small>
                  </span>
                </button>
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
