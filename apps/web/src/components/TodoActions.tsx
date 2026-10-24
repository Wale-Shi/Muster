import { useI18n } from "../i18n";
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
  const { t } = useI18n();
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
            {t("ui.start")}<ChevronDown size={12} />
          </button>
        )}
        {todo.phase === "confirm" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={() => run("confirm")}
          >
            <Check size={14} />
            {t("ui.confirmPlan")}
          </button>
        )}
        {todo.phase === "review" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={onDone}
          >
            <Check size={14} />
            {t("ui.done")}
          </button>
        )}
        {todo.phase === "failed" && (
          <button
            className="button primary"
            disabled={pending}
            onClick={() => setMenu("rerun")}
          >
            <RotateCcw size={13} />
            {t("ui.rerun")}<ChevronDown size={12} />
          </button>
        )}
        {isRunning(todo.phase) && (
          <button
            className="button"
            disabled={
              pending || todo.builds.at(-1)?.turns.at(-1)?.status !== "running"
            }
            onClick={() => run("stop")}
            title={t("ui.requestACooperativeStop")}
          >
            <Pause size={13} />
            {t("ui.stop")}
          </button>
        )}
        {["done", "closed"].includes(todo.phase) ? (
          <button
            className="button"
            disabled={pending}
            onClick={() => run("reopen")}
          >
            <RotateCcw size={13} />
            {t("ui.reopen")}
          </button>
        ) : (
          <button
            className="button ghost"
            disabled={pending}
            onClick={() => run("close")}
          >
            <X size={13} />
            {t("ui.close")}
          </button>
        )}
        {pending && <span className="hint">{t("ui.updating")}</span>}
      </div>
      <ErrorNotice error={menu ? null : mutation.error} />
      {menu && (
        <Dialog
          title={menu === "start" ? t("ui.startTask") : t("ui.rerunTask")}
          onClose={() => setMenu(null)}
        >
          <div className="dialog-body form-stack">
            <p className="muted">
              {menu === "start"
                ? t("ui.chooseHowYourAgentShouldApproachThisTask")
                : t("ui.continueTheExistingBuildOrBeginAFreshBuild")}
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
                    <strong>{t("ui.planFirst")}</strong>
                    <small>{t("ui.reviewAPlanBeforeTheAgentWritesCode")}</small>
                  </span>
                </button>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("start", { mode: "run" })}
                >
                  <Play size={18} />
                  <span>
                    <strong>{t("ui.runNow")}</strong>
                    <small>{t("ui.startBuildingRightAway")}</small>
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
                    <strong>{t("ui.continue")}</strong>
                    <small>{t("ui.keepTheExistingWorktreeAndSession")}</small>
                  </span>
                </button>
                <button
                  className="choice-button"
                  disabled={pending}
                  onClick={() => run("rerun", { strategy: "restart" })}
                >
                  <RotateCcw size={18} />
                  <span>
                    <strong>{t("ui.startOver")}</strong>
                    <small>{t("ui.createANewBuildWithAFreshSession")}</small>
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
