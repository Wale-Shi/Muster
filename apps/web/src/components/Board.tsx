import { useEffect, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { Circle, Plus, SlidersHorizontal } from "lucide-react";
import type { Agent, Project, Todo } from "@muster/shared";
import { boardTodos, type ColumnId } from "../lib/board";
import { relativeTime } from "../lib/format";
import { Avatar, PhaseDot } from "./ui";

const columns: { id: ColumnId; title: string; empty: string }[] = [
  { id: "backlog", title: "Backlog", empty: "Nothing waiting to start" },
  { id: "in_progress", title: "In progress", empty: "Nothing in progress" },
  { id: "needs_you", title: "Needs you", empty: "Nothing waiting on you" },
  { id: "done", title: "Done", empty: "Nothing finished yet" },
];
export function TaskCard({
  todo,
  project,
  agent,
  overlay = false,
}: {
  todo: Todo;
  project?: Project | undefined;
  agent?: Agent | undefined;
  overlay?: boolean;
}) {
  const drag = useDraggable({ id: todo.id, data: { todo }, disabled: overlay });
  return (
    <article
      ref={drag.setNodeRef}
      style={{ transform: CSS.Translate.toString(drag.transform) }}
      {...drag.listeners}
      {...drag.attributes}
      className={`task-card ${drag.isDragging ? "dragging" : ""} ${overlay ? "overlay-card" : ""}`}
      aria-label={`Drag task #${todo.number}: ${todo.title}`}
    >
      <div className="card-top">
        <PhaseDot phase={todo.phase} />
        <span className="mono dim">#{todo.number}</span>
        <span className="card-time" title="Time since last update">
          {relativeTime(todo.updatedAt)}
        </span>
      </div>
      <Link
        to={`/todos/${todo.id}`}
        className="card-title"
        onClick={(event) => {
          if (drag.isDragging) event.preventDefault();
        }}
      >
        {todo.title}
      </Link>
      <div className="card-footer">
        <span className="project-tag">
          <span className="project-square" />
          {project?.name ?? "Project"}
        </span>
        {agent ? (
          <Avatar name={agent.name} small />
        ) : (
          <span className="unassigned" title="Unassigned">
            —
          </span>
        )}
      </div>
    </article>
  );
}
function Column({
  id,
  title,
  empty,
  todos,
  projects,
  agents,
  onNew,
}: {
  id: ColumnId;
  title: string;
  empty: string;
  todos: Todo[];
  projects: Project[];
  agents: Agent[];
  onNew: () => void;
}) {
  const drop = useDroppable({ id: `column-${id}`, disabled: id !== "done" });
  return (
    <section
      ref={drop.setNodeRef}
      className={`board-column ${drop.isOver ? "drop-active" : ""}`}
    >
      <div className="column-header">
        <span className={`column-dot ${id}`} />
        <h3>{title}</h3>
        <span className="column-count">{todos.length}</span>
        {id === "backlog" && (
          <button
            className="icon-button"
            onClick={onNew}
            aria-label="Add to backlog"
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {id === "done" && <div className="column-subtitle">Last 7 days</div>}
      <div className="column-cards">
        {todos.map((todo) => (
          <TaskCard
            key={todo.id}
            todo={todo}
            project={projects.find((project) => project.id === todo.projectId)}
            agent={agents.find(
              (agent) =>
                agent.id ===
                (todo.phase === "planning"
                  ? (todo.planAgentId ?? todo.agentId)
                  : todo.agentId),
            )}
          />
        ))}
        {!todos.length && (
          <div className="column-empty">
            <Circle size={18} strokeWidth={1} />
            <span>{empty}</span>
          </div>
        )}
      </div>
    </section>
  );
}
export function Board({
  todos,
  projects,
  agents,
  onNew,
}: {
  todos: Todo[];
  projects: Project[];
  agents: Agent[];
  onNew: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [, refreshElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => refreshElapsed((value) => value + 1),
      30_000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="board">
      <div className="board-toolbar">
        <span className="muted">
          All tasks{" "}
          <span className="dim">
            {todos.filter((todo) => todo.phase !== "closed").length}
          </span>
        </span>
        <label className="board-filter">
          <SlidersHorizontal size={12} />
          <select
            aria-label="Filter board by project"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="board-columns">
        {columns.map((column) => (
          <Column
            key={column.id}
            {...column}
            todos={boardTodos(
              todos.filter((todo) => !filter || todo.projectId === filter),
              column.id,
            )}
            projects={projects}
            agents={agents}
            onNew={onNew}
          />
        ))}
      </div>
    </div>
  );
}
