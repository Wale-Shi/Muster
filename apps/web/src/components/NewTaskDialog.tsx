import { MentionInput } from "./MentionInput";
import { useI18n } from "../i18n";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ArrowRight, ListTodo, Play } from "lucide-react";
import { api } from "../api/client";
import { useAgents, useProjects } from "../api/queries";
import { Dialog, ErrorNotice } from "./ui";

export function NewTaskDialog({
  onClose,
  topicId,
}: {
  onClose: () => void;
  topicId?: string;
}) {
  const { t, label } = useI18n();
  const projects = useProjects();
  const agents = useAgents();
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const selectedProject = projectId || projects.data?.[0]?.id || "";
  const selectedAgent =
    agentId ?? agents.data?.find((agent) => !agent.isChief)?.id ?? "";
  const create = useMutation({
    mutationFn: async (mode: "plan" | "run" | "backlog") => {
      const todoId =
        createdId ??
        (
          await api.createTodo({
            projectId: selectedProject,
            agentId: selectedAgent || null,
            title: title.trim(),
            spec,
            mode: mode === "run" ? "run" : "plan",
            ...(topicId ? { topicId } : {}),
          })
        ).id;
      setCreatedId(todoId); // Retrying a failed start must not create a duplicate task.
      await client.invalidateQueries({ queryKey: ["todos"] });
      if (mode !== "backlog")
        await api.action(todoId, "start", {
          mode,
          ...(selectedAgent ? { agentId: selectedAgent } : {}),
        });
      return todoId;
    },
    onSuccess: (id) => {
      void client.invalidateQueries({ queryKey: ["todos"] });
      onClose();
      void navigate(`/todos/${id}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate("plan");
  };
  const disabled = create.isPending || !selectedProject || !title.trim();
  return (
    <Dialog title={t("ui.newTask")} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <ErrorNotice error={projects.error || agents.error} />
          {!projects.isPending && !projects.data?.length && (
            <p className="notice">
              {t("ui.createAProjectInProjectsBeforeAddingATask")}
            </p>
          )}
          <div className="form-row">
            <label>
              {t("ui.project")}<select
                required
                value={selectedProject}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={!!createdId}
              >
                <option value="" disabled>
                  {t("ui.selectProject")}
                </option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("ui.agent")}<select
                value={selectedAgent}
                onChange={(event) => setAgentId(event.target.value)}
              >
                <option value="">{t("ui.defaultAgent")}</option>
                {agents.data
                  ?.filter((agent) => !agent.isChief)
                  .map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} · {label("runtime", agent.runtime)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <input
            className="title-input"
            aria-label={t("ui.taskTitle")}
            placeholder={t("ui.whatNeedsToGetDone")}
            autoFocus
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={!!createdId}
          />
          <MentionInput
            aria-label={t("ui.taskDescription")}
            placeholder={t("ui.addADescriptionContextOrAFewAcceptanceCriteria")}
            rows={7}
            value={spec}
            onValue={setSpec}
            onAgent={(id) => { if (!agentId) setAgentId(id); }}
            disabled={!!createdId}
          />
          <ErrorNotice error={create.error} />
          {createdId && create.isError && (
            <p className="hint">
              {t("ui.taskSavedRetryStartingItOrOpenItFromTheBoard")}
            </p>
          )}
        </div>
        <div className="dialog-footer task-footer">
          <button
            type="button"
            className="button ghost"
            disabled={disabled}
            onClick={() => create.mutate("backlog")}
          >
            <ListTodo size={14} />
            {t("ui.saveToBacklog")}
          </button>
          <div className="row">
            <button type="button" className="button ghost" onClick={onClose}>{t("ui.cancel")}</button>
            <button
              type="button"
              className="button"
              disabled={disabled}
              onClick={() => create.mutate("run")}
            >
              <Play size={13} />
              {t("ui.runNow")}
            </button>
            <button className="button primary" disabled={disabled}>
              <ArrowRight size={14} />
              {create.isPending ? t("ui.creating") : t("ui.planFirst")}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
