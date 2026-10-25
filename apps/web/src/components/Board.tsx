import { useI18n, type MessageKey } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Link } from "react-router";
import { CircleCheck, CircleHelp, Hand, ListTodo, Plus, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import type { Agent, Project, Todo } from "@muster/shared";
import { boardTodos, type ColumnId } from "../lib/board";
import { Avatar, PhaseDot } from "./ui";

const columns: { id: ColumnId; title: MessageKey; empty: MessageKey }[] = [
  { id: "backlog", title: "ui.backlog", empty: "ui.nothingWaitingToStart" },
  { id: "in_progress", title: "ui.inProgress", empty: "ui.nothingInProgress" },
  { id: "needs_you", title: "ui.needsYou", empty: "ui.nothingWaitingOnYou" },
  { id: "done", title: "ui.done", empty: "ui.nothingFinishedYet" },
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
  const { t, label, formatAge, formatDate } = useI18n();
  const drag = useDraggable({ id: todo.id, data: { todo }, disabled: overlay });
  return (
    <article
      ref={drag.setNodeRef}
      style={{ transform: CSS.Translate.toString(drag.transform) }}
      {...drag.listeners}
      {...drag.attributes}
      className={`task-card ${drag.isDragging ? "dragging" : ""} ${overlay ? "overlay-card" : ""}`}
      aria-roledescription={t("text.draggable")}
      aria-label={t("text.drag", { number: todo.number, title: todo.title })}
    >
      <div className="card-top">
        <PhaseDot phase={todo.phase} />
        <span className="mono dim">#{todo.number}</span>
        {["confirm", "review", "failed"].includes(todo.phase) && (
          <span title={label("phase", todo.phase)} className={`card-gate ${todo.phase}`}>{label("phase", todo.phase)}</span>
        )}
        <span className="card-time" title={`${t("ui.timeSinceLastUpdate")}: ${formatDate(todo.updatedAt)}`}>
          {formatAge(todo.updatedAt)}
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
        <span className="project-tag" title={project?.name}>
          <span className="project-square" />
          {project?.name ?? t("ui.project")}
        </span>
        {agent ? (
          <Avatar name={agent.name} small />
        ) : (
          <span className="unassigned" title={t("ui.unassigned")}>
            —
          </span>
        )}
      </div>
    </article>
  );
}
const columnIcons: Record<ColumnId, LucideIcon> = { backlog: ListTodo, in_progress: Sparkles, needs_you: Hand, done: CircleCheck };
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
  const { t, formatNumber } = useI18n();
  const drop = useDroppable({ id: `column-${id}`, disabled: id !== "done" });
  return (
    <section
      ref={drop.setNodeRef}
      aria-label={title}
      className={`board-column ${drop.isOver ? "drop-active" : ""}`}
    >
      <div className="column-header">
        <span className={`column-dot ${id}`} />
        <h3 title={title}>{title}</h3>
        <span className="column-count">{formatNumber(todos.length)}</span>
        {id === "done" && <span className="column-subtitle">{t("ui.last7Days")}</span>}
        {id === "backlog" && (
          <button
            className="icon-button"
            onClick={onNew}
            aria-label={t("ui.addToBacklog")}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
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
        {!todos.length && (() => {
          const Icon = columnIcons[id];
          return (
            <div className="column-empty">
              <span className="column-empty-icon"><Icon size={15} /></span>
              <span>{empty}</span>
            </div>
          );
        })()}
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
  const { t, formatNumber } = useI18n();
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
        <span className="muted board-title">
          {t("ui.allTasks")}{" "}
          <span className="dim">
            {formatNumber(todos.filter((todo) => todo.phase !== "closed").length)}
          </span>
          <button className="icon-button sm" aria-label={t("phaseC.help")} title={t("phaseC.help")} popoverTarget="board-help"><CircleHelp size={13} /></button>
          <div id="board-help" popover="auto" className="board-help">{t("phaseC.boardHelp")}</div>
        </span>
        <label className="board-filter">
          <SlidersHorizontal size={12} />
          <select
            aria-label={t("ui.filterBoardByProject")}
            value={filter}
            onChange={(event) => {
              navigated.current = false;
              setFilter(event.target.value);
            }}
          >
            <option value="">{t("ui.allProjects")}</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <nav className="board-paging" aria-label={t("ui.boardColumns")}>
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
            <span>{t(column.title)}</span>{" "}<span>{formatNumber(grouped[index]!.length)}</span>
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
            title={t(column.title)} empty={t(column.empty)}
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
