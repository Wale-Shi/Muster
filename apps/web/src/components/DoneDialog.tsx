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
    <Dialog title="Mark task as done" onClose={onClose}>
      <div className="dialog-body">
        <p className="muted">
          Finish <span className="mono">#{todo.number}</span> {todo.title}
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={merge}
            onChange={(event) => setMerge(event.target.checked)}
          />
          Merge changes into the default branch
        </label>
        <p className="hint">
          {merge
            ? "A machine will merge this build. The task stays in progress until the merge succeeds."
            : "The task will be completed and its branch kept without merging."}
        </p>
        <ErrorNotice error={done.error} />
      </div>
      <div className="dialog-footer">
        <button onClick={onClose} className="button">
          Cancel
        </button>
        <button
          className="button primary"
          disabled={done.isPending}
          onClick={() => done.mutate()}
        >
          <Check size={14} />
          {done.isPending ? "Finishing…" : "Done"}
        </button>
      </div>
    </Dialog>
  );
}
