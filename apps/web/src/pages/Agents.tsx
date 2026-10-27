import { Link, useNavigate } from "react-router";
import { useI18n } from "../i18n";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus } from "lucide-react";
import { CLI_DEFAULT_MODEL, DEFAULT_MODELS, type Agent, type Runtime } from "@muster/shared";
import { api, type AgentInput } from "../api/client";
import { useAgents, useTodos } from "../api/queries";
import { Avatar, Dialog, Empty, ErrorNotice, Loading } from "../components/ui";
import { RuntimeOptions } from "../components/RuntimeOptions";

function AgentDialog({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [input, setInput] = useState<AgentInput>({
    name: agent?.name ?? "",
    role: agent?.role ?? "",
    runtime: agent?.runtime ?? "codex",
    model: agent?.model ?? DEFAULT_MODELS.codex,
    reasoning: agent?.reasoning ?? null,
  });
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api.saveAgent(
        {
          ...input,
          name: input.name.trim(),
          role: input.role.trim(),
          model: input.model.trim(),
        },
        agent?.id,
      ),
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: ["agents"] });
      onClose();
      navigate(`/agents/${saved.id}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (missing.length || save.isPending) return;
    save.mutate();
  };
  const missing = (["name", "role", "model"] as const).filter((field) => !input[field].trim());
  return (
    <Dialog title={agent ? t("ui.editAgent") : t("ui.createAgent")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <label>
            {t("ui.nameRequired")}<input
              autoFocus
              required
              value={input.name}
              placeholder={t("ui.egAtlas")}
              onChange={(event) =>
                setInput({ ...input, name: event.target.value })
              }
            />
          </label>
          <label>
            {t("ui.roleRequired")}<textarea
              required
              rows={3}
              value={input.role}
              placeholder={t("ui.whatIsThisAgentResponsibleFor")}
              onChange={(event) =>
                setInput({ ...input, role: event.target.value })
              }
            />
          </label>
          <div className="form-row">
            <label>
              {t("ui.runtimeRequired")}<select
                required
                value={input.runtime}
                onChange={(event) =>
                  setInput({ ...input, runtime: event.target.value as Runtime, model: DEFAULT_MODELS[event.target.value as Runtime] })
                }
              >
                <RuntimeOptions />
              </select>
            </label>
            <label>
              {t("ui.modelRequired")}<input
                required
                value={input.model}
                placeholder={
                  input.runtime === "mock" ? "mock" : t("ui.modelIdentifier")
                }
                onChange={(event) =>
                  setInput({ ...input, model: event.target.value })
                }
              />
              {input.model === CLI_DEFAULT_MODEL && <small className="muted">{t("ui.cliDefaultModel")}</small>}
            </label>
          </div>
          <label>
            {t("ui.reasoning")}<input
              value={input.reasoning ?? ""}
              placeholder={t("ui.egHighOptional")}
              onChange={(event) =>
                setInput({ ...input, reasoning: event.target.value || null })
              }
            />
          </label>
          <ErrorNotice error={save.error} />
          {missing.length > 0 && (
            <p className="hint" id="agent-required" role="status">
              {t(agent ? "text.requiredSave" : "text.requiredCreate", { fields: missing.map((field) => t(`field.${field}`)).join(", ") })}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            {t("ui.cancel")}
          </button>
          <button
            className="button primary"
            disabled={save.isPending || missing.length > 0}
            aria-describedby={missing.length ? "agent-required" : undefined}
          >
            {save.isPending
              ? t("ui.saving")
              : agent
                ? t("ui.saveChanges")
                : t("ui.createAgent")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function Agents() {
  const { t, label } = useI18n();
  const agents = useAgents();
  const todos = useTodos();
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>{t("ui.agents")}</h1>
        <button className="button primary" onClick={() => setEditing(null)}>
          <Plus size={14} />
          {t("ui.newAgent")}
        </button>
      </header>
      <div className="page-content">
        <ErrorNotice error={agents.error || todos.error} />
        {agents.isPending ? (
          <Loading />
        ) : !agents.data?.length ? (
          <Empty icon={<Bot size={26} />} title={t("ui.meetYourNextTeammate")}>
            <button className="button" onClick={() => setEditing(null)}>
              {t("ui.createAnAgent")}
            </button>
          </Empty>
        ) : (
          <div className="agent-grid">
            {agents.data.map((agent) => {
              const active =
                todos.data?.filter(
                  (todo) =>
                    todo.agentId === agent.id &&
                    !["todo", "done", "closed"].includes(todo.phase),
                ).length ?? 0;
              return (
                <Link to={`/agents/${agent.id}`} className="agent-card" key={agent.id}>
                  <div className="agent-card-header">
                    <Avatar name={agent.name} />
                    <div>
                      <h3>
                        {agent.name}
                        {agent.isChief && <span className="badge">Chief</span>}
                      </h3>
                      <span className="mono muted">{label("runtime", agent.runtime)}</span>
                    </div>

                  </div>
                  <p className="agent-role">{agent.role}</p>
                  <div className="agent-model mono">
                    {agent.model}
                    {agent.reasoning && (
                      <span className="dim"> · {agent.reasoning}</span>
                    )}
                  </div>
                  <div className="agent-card-footer">
                    <span className={`status-dot ${active ? "indigo" : ""}`} />
                    <span>
                      {t("count.active", { count: active })}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
      {editing !== undefined && (
        <AgentDialog agent={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}
