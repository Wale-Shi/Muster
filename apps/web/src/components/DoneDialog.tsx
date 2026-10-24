import { useI18n } from "../i18n";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Todo } from "@muster/shared";
import { Check } from "lucide-react";
import { api } from "../api/client";
import { Dialog, ErrorNotice } from "./ui";

export function DoneDialog({
  todo,
  onClose,
}: {
  todo: Todo;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [merge, setMerge] = useState(true);
  const client = useQueryClient();
  const done = useMutation({
    mutationFn: () => api.action(todo.id, "done", { merge }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["todos"] }),
        client.invalidateQueries({ queryKey: ["todo", todo.id] }),
      ]);
      onClose();
    },
  });
  return (
    <Dialog title={t("ui.markTaskAsDone")} onClose={onClose}>
      <div className="dialog-body">
        <p className="muted">
          {t("text.finish", { number: todo.number, title: todo.title })}
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={merge}
            onChange={(event) => setMerge(event.target.checked)}
          />
          {t("ui.mergeChangesIntoTheDefaultBranch")}
        </label>
        <p className="hint">
          {merge
            ? t("ui.aMachineWillMergeThisBuildTheTaskStaysInProgressUntilTheMergeSucceeds")
            : t("ui.theTaskWillBeCompletedAndItsBranchKeptWithoutMerging")}
        </p>
        <ErrorNotice error={done.error} />
      </div>
      <div className="dialog-footer">
        <button onClick={onClose} className="button">
          {t("ui.cancel")}
        </button>
        <button
          className="button primary"
          disabled={done.isPending}
          onClick={() => done.mutate()}
        >
          <Check size={14} />
          {done.isPending ? t("ui.finishing") : t("ui.done")}
        </button>
      </div>
    </Dialog>
  );
}
