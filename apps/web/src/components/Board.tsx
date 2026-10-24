import { useEffect, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { Circle, Plus, SlidersHorizontal } from "lucide-react";
import type { Agent, Project, Todo } from "@muster/shared";
import { boardTodos, phaseLabels, type ColumnId } from "../lib/board";
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
        {["confirm", "review", "failed"].includes(todo.phase) && (
          <span className={`card-gate ${todo.phase}`}>{phaseLabels[todo.phase]}</span>
        )}
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
      aria-label={title}
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
  const grouped = columns.map((column) => boardTodos(
    todos.filter((todo) => !filter || todo.projectId === filter), column.id,
  ));
  const preferred = grouped[2]!.length ? 2 : grouped[1]!.length ? 1 : grouped[0]!.length ? 0 : grouped[3]!.length ? 3 : 0;
  const [activeColumn, setActiveColumn] = useState(preferred);
  const track = useRef<HTMLDivElement>(null);
  const currentColumn = useRef(preferred);
  const navigated = useRef(false);
  const scrollToColumn = (index: number) => {
    const element = track.current;
    const first = element?.children[0] as HTMLElement | undefined;
    const column = element?.children[index] as HTMLElement | undefined;
    if (element && first && column && window.matchMedia?.("(max-width: 767px)").matches) {
      element.scrollTo({ left: column.offsetLeft - first.offsetLeft, behavior: "instant" });
    }
  };
  useEffect(() => {
    if (navigated.current) return;
    currentColumn.current = preferred;
    setActiveColumn(preferred);
    scrollToColumn(preferred);
  }, [preferred, filter]);
  useEffect(() => {
    const element = track.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    // The mobile board initially sits inside a hidden Chat/Board panel.
    // Reapply its page when it becomes visible or its viewport changes size.
    const observer = new ResizeObserver(() => scrollToColumn(currentColumn.current));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
            onChange={(event) => {
              navigated.current = false;
              setFilter(event.target.value);
            }}
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
      <nav className="board-paging" aria-label="Board columns">
        {columns.map((column, index) => (
          <button
            key={column.id}
            aria-current={activeColumn === index ? "true" : undefined}
            onClick={() => {
              navigated.current = true;
              currentColumn.current = index;
              setActiveColumn(index);
              scrollToColumn(index);
            }}
          >
            <span>{column.title}</span>{" "}<span>{grouped[index]!.length}</span>
          </button>
        ))}
      </nav>
      <div
        className="board-columns"
        ref={track}
        onTouchStart={() => { navigated.current = true; }}
        onWheel={() => { navigated.current = true; }}
        onScroll={() => {
          const element = track.current;
          if (!element?.clientWidth || !window.matchMedia?.("(max-width: 767px)").matches) return;
          const first = element.children[0] as HTMLElement;
          const nearest = columns.reduce((best, _, index) => {
            const offset = (element.children[index] as HTMLElement).offsetLeft - first.offsetLeft;
            const bestOffset = (element.children[best] as HTMLElement).offsetLeft - first.offsetLeft;
            return Math.abs(offset - element.scrollLeft) < Math.abs(bestOffset - element.scrollLeft) ? index : best;
          }, 0);
          currentColumn.current = nearest;
          setActiveColumn(nearest);
        }}
      >
        {columns.map((column, index) => (
          <Column
            key={column.id}
            {...column}
            todos={grouped[index]!}
            projects={projects}
            agents={agents}
            onNew={onNew}
          />
        ))}
      </div>
    </div>
  );
}
