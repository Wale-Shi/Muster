import { WorkspaceDialog } from "../pages/Workspaces";
import { ProjectMonogram } from "./ProjectMonogram";
import { MusterMark } from "./MusterMark";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router";
import {
  BarChart3,
  BookOpen,
  Plug,
  Bot,
  Check,
  ChevronsUpDown,
  LoaderCircle,
  MessageSquare,
  Settings,
  SlidersHorizontal,
  PanelLeftClose,
  Plus,
  SquarePlus,
  X,
} from "lucide-react";
import type { Project, Todo } from "@muster/shared";
import { useAgents, useTodos, useMachines, useProjects } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { useCurrentWorkspaceId } from "../hooks/useCurrentWorkspace";
import { isRunning } from "../lib/board";

export function connectionStatus(connected: boolean, onlineCount: number | undefined) {
  if (!connected) return "connecting";
  if (onlineCount === undefined) return "unknown";
  return onlineCount > 0 ? "online" : "offline";
}

/** A workspace is running while its master agent or any task works, and needs you at review or failure. */
export function workspaceStatus(project: Project, todos: Todo[], masterActive: boolean, unread: boolean) {
  const tasks = todos.filter((todo) => todo.projectId === project.id);
  if (masterActive || tasks.some((todo) => isRunning(todo.phase))) return "running";
  if (tasks.some((todo) => todo.phase === "failed")) return "failed";
  if (tasks.some((todo) => todo.phase === "review")) return "needs-you";
  return unread ? "unread" : "idle";
}

const ACTIVE_ORDER: Partial<Record<Todo["phase"], number>> = { failed: 0, review: 1, building: 2, queued: 3 };
const SIDEBAR_TASKS = 8;

/** Tasks worth a shortcut: those needing you first, then those running. */
export function activeTasks(todos: Todo[], projectId: string | undefined) {
  return todos
    .filter((todo) => todo.projectId === projectId && ACTIVE_ORDER[todo.phase] !== undefined)
    .sort((a, b) => ACTIVE_ORDER[a.phase]! - ACTIVE_ORDER[b.phase]! || b.number - a.number);
}

function StatusMark({ status }: { status: string }) {
  const { label } = useI18n();
  return status === "running"
    ? <LoaderCircle className="spin" size={11} aria-label={label("status", "running")} />
    : <span className={`topic-status ${status}`} aria-label={label("status", status)} />;
}

function WorkspaceSwitcher({ current, statusOf, onNavigate }: {
  current: Project | undefined;
  statusOf: (project: Project) => string;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 4, left: rect.left });
    setOpen(!open);
  };
  const done = () => { setOpen(false); onNavigate(); };
  return (
    <>
      <button ref={button} className="workspace-switcher" onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={t("ws.switch")}>
        {current ? <ProjectMonogram name={current.name} /> : <span className="brand-icon"><MusterMark size={14} /></span>}
        <strong>{current?.name ?? "Muster"}</strong>
        <ChevronsUpDown size={13} />
      </button>
      {open && (
        <div ref={menu} className="workspace-menu" role="menu" style={position}>
          {projects.data?.map((project) => (
            <Link key={project.id} role="menuitem" className="workspace-menu-item" to={`/w/${project.id}`} onClick={done}>
              <ProjectMonogram name={project.name} />
              <span>{project.name}</span>
              {project.id === current?.id ? <Check size={13} /> : <StatusMark status={statusOf(project)} />}
            </Link>
          ))}
          <div className="workspace-menu-separator" />
          {current && (
            <Link role="menuitem" className="workspace-menu-item" to={`/w/${current.id}/settings`} onClick={done}>
              <SlidersHorizontal size={14} />
              <span>{t("ws.settings")}</span>
            </Link>
          )}
          <button role="menuitem" className="workspace-menu-item" onClick={() => { setOpen(false); setCreating(true); }}>
            <Plus size={14} />
            <span>{t("ws.new")}</span>
          </button>
        </div>
      )}
      {creating && <WorkspaceDialog onClose={() => { setCreating(false); onNavigate(); }} />}
    </>
  );
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  onNewTask,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
  onNewTask: () => void;
}) {
  const { t, label } = useI18n();
  const machines = useMachines();
  const todos = useTodos();
  const agents = useAgents();
  const realtime = useRealtime();
  const projects = useProjects();
  const currentId = useCurrentWorkspaceId();
  const current = projects.data?.find((project) => project.id === currentId);
  const onlineCount = machines.data?.filter((machine) => machine.online).length;
  const connection = connectionStatus(realtime.connected, machines.isError ? undefined : onlineCount);
  const statusOf = (project: Project) => {
    const activity = realtime.activity[project.topicId];
    return workspaceStatus(project, todos.data ?? [], !!activity && activity.status !== "idle", !!activity?.unread);
  };
  const master = agents.data?.find((agent) => agent.id === current?.chiefAgentId) ?? agents.data?.find((agent) => agent.isChief);
  const masterActivity = current ? realtime.activity[current.topicId] : undefined;
  const masterStatus = masterActivity && masterActivity.status !== "idle" ? "running" : masterActivity?.unread ? "unread" : null;
  const tasks = activeTasks(todos.data ?? [], current?.id);
  const taskCount = todos.data?.filter((todo) => todo.projectId === current?.id && todo.phase !== "closed").length ?? 0;
  const config = [
    { to: "/agents", title: t("ui.agents"), icon: Bot },
    { to: "/skills", title: t("parity.skills"), icon: BookOpen },
    { to: "/connections", title: t("phaseB.connections"), icon: Plug },
    { to: "/usage", title: t("usage.title"), icon: BarChart3 },
  ];
  const connectionText = connection === "connecting" ? t("ui.connectingToServer")
    : connection === "unknown" ? t("ui.machineStatusUnavailable")
    : connection === "offline" ? t("ui.noMachinesOnline")
    : t("ws.ready");
  return (
    <>
      <button
        className={`sidebar-scrim ${mobileOpen ? "visible" : ""}`}
        aria-label={t("ui.closeNavigation")}
        onClick={onCloseMobile}
      />
      <aside
        className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}
      >
        <div className="sidebar-brand">
          <WorkspaceSwitcher current={current} statusOf={statusOf} onNavigate={onCloseMobile} />
          <button
            className="icon-button collapse-control"
            onClick={onToggle}
            aria-label={t("ui.collapseSidebar")}
            title={t("ui.collapseSidebar")}
          >
            <PanelLeftClose size={15} />
          </button>
          <button
            className="icon-button mobile-close"
            onClick={onCloseMobile}
            aria-label={t("ui.closeSidebar")}
          >
            <X size={16} />
          </button>
        </div>
        <nav aria-label={t("ui.mainNavigation")}>
          {current && (
            <>
              <div className="sidebar-heading">{t("ws.conversation")}</div>
              <NavLink
                end
                to={`/w/${current.id}`}
                className={({ isActive }) => `nav-item conversation-item ${isActive ? "active" : ""}`}
                onClick={onCloseMobile}
                title={t("ws.conversationHelp")}
              >
                <MessageSquare size={16} />
                <span className="nav-text">
                  <span>{t("ws.mainConversation")}</span>
                  <small>{t("ws.conversationWith", { name: master?.name ?? "Chief" })}</small>
                </span>
                {masterStatus && <StatusMark status={masterStatus} />}
              </NavLink>
              <div className="sidebar-heading">{t("ws.tasks")}</div>
              <button className="nav-item new-task-item" onClick={onNewTask} title={t("ws.newTaskHelp")}>
                <SquarePlus size={16} />
                <span>{t("ui.newTask")}</span>
              </button>
              <div className="task-list" aria-label={t("ws.activeTasks")}>
                {tasks.slice(0, SIDEBAR_TASKS).map((todo) => (
                  <NavLink
                    key={todo.id}
                    to={`/todos/${todo.id}`}
                    className={({ isActive }) => `topic-item task-item ${isActive ? "active" : ""}`}
                    onClick={onCloseMobile}
                    title={`#${todo.number} ${todo.title} · ${label("phase", todo.phase)}`}
                  >
                    <StatusMark status={isRunning(todo.phase) ? "running" : todo.phase === "failed" ? "failed" : "needs-you"} />
                    <span>#{todo.number} {todo.title}</span>
                  </NavLink>
                ))}
                {!tasks.length && <div className="task-list-empty">{t("ws.noActiveTasks")}</div>}
                {taskCount > 0 && (
                  <Link className="task-list-more" to={`/w/${current.id}`} onClick={onCloseMobile}>
                    {t("ws.allTasks", { count: taskCount })}
                  </Link>
                )}
              </div>
            </>
          )}
          {projects.data && !projects.data.length && (
            <WorkspaceEmptyHint />
          )}
        </nav>
        <footer className="sidebar-footer">
          {config.map(({ to, title, icon: Icon }) => (
            <NavLink className="nav-item" to={to} key={to} title={title} onClick={onCloseMobile}>
              <Icon size={16} />
              <span>{title}</span>
            </NavLink>
          ))}
          <NavLink className="nav-item" to="/settings" title={`${t("phaseC.settings")} · ${connectionText}`} onClick={onCloseMobile}>
            <Settings size={16} />
            <span>{t("phaseC.settings")}</span>
            <span
              className={`status-dot settings-status ${connection === "online" ? "online" : connection === "offline" ? "warning" : ""}`}
              aria-label={connectionText}
            />
          </NavLink>
        </footer>
      </aside>
    </>
  );
}

function WorkspaceEmptyHint() {
  const { t } = useI18n();
  return <p className="task-list-empty">{t("ws.needWorkspace")}</p>;
}
