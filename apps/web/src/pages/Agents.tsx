import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Plus } from "lucide-react";
import { DEFAULT_MODELS, type Agent, type Runtime } from "@muster/shared";
import { api, type AgentInput } from "../api/client";
import { useAgents, useTodos } from "../api/queries";
import { Avatar, Dialog, Empty, ErrorNotice, Loading } from "../components/ui";

function AgentDialog({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
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
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["agents"] });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Dialog title={agent ? "Edit agent" : "Create agent"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <label>
            Name
            <input
              autoFocus
              required
              value={input.name}
              placeholder="e.g. Atlas"
              onChange={(event) =>
                setInput({ ...input, name: event.target.value })
              }
            />
          </label>
          <label>
            Role
            <textarea
              required
              rows={3}
              value={input.role}
              placeholder="What is this agent responsible for?"
              onChange={(event) =>
                setInput({ ...input, role: event.target.value })
              }
            />
          </label>
          <div className="form-row">
            <label>
              Runtime
              <select
                value={input.runtime}
                onChange={(event) =>
                  setInput({ ...input, runtime: event.target.value as Runtime, model: DEFAULT_MODELS[event.target.value as Runtime] })
                }
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="mock">Mock (local test)</option>
              </select>
            </label>
            <label>
              Model
              <input
                required
                value={input.model}
                placeholder={
                  input.runtime === "mock" ? "mock" : "Model identifier"
                }
                onChange={(event) =>
                  setInput({ ...input, model: event.target.value })
                }
              />
            </label>
          </div>
          <label>
            Reasoning
            <input
              value={input.reasoning ?? ""}
              placeholder="e.g. high (optional)"
              onChange={(event) =>
                setInput({ ...input, reasoning: event.target.value || null })
              }
            />
          </label>
          <ErrorNotice error={save.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              save.isPending ||
              !input.name.trim() ||
              !input.role.trim() ||
              !input.model.trim()
            }
          >
            {save.isPending
              ? "Saving…"
              : agent
                ? "Save changes"
                : "Create agent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function Agents() {
  const agents = useAgents();
  const todos = useTodos();
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined);
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>Agents</h1>
        <button className="button primary" onClick={() => setEditing(null)}>
          <Plus size={14} />
          New agent
        </button>
      </header>
      <div className="page-content">
        <div className="page-intro">
          <h2>Your team, ready to build.</h2>
          <p>Give each agent a role, a runtime, and a little direction.</p>
        </div>
        <ErrorNotice error={agents.error || todos.error} />
        {agents.isPending ? (
          <Loading />
        ) : !agents.data?.length ? (
          <Empty icon={<Bot size={26} />} title="Meet your next teammate">
            <button className="button" onClick={() => setEditing(null)}>
              Create an agent
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
                <article className="agent-card" key={agent.id}>
                  <div className="agent-card-header">
                    <Avatar name={agent.name} />
                    <div>
                      <h3>
                        {agent.name}
                        {agent.isChief && <span className="badge">Chief</span>}
                      </h3>
                      <span className="mono muted">{agent.runtime}</span>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => setEditing(agent)}
                      aria-label={`Edit ${agent.name}`}
                    >
                      <Pencil size={14} />
                    </button>
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
                      {active} active {active === 1 ? "task" : "tasks"}
                    </span>
                  </div>
                </article>
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
