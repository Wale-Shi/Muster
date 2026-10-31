import { useWorkspaceSettings } from "../pages/Settings";
import { WorkspaceDialog } from "../pages/Workspaces";
import { ProjectMonogram } from "./ProjectMonogram";
import { MusterMark } from "./MusterMark";
import { useI18n } from "../i18n";
import { useState } from "react";
import { NavLink } from "react-router";
import {
  BookOpen,
  Plug,
  Bot,
  LoaderCircle,
  Settings,
  PanelLeftClose,
  Plus,
  X,
} from "lucide-react";
import type { Project, Todo } from "@muster/shared";
import { useTodos, useMachines, useProjects } from "../api/queries";
import { useRealtime } from "../api/realtime";
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
  const realtime = useRealtime();
  const settings = useWorkspaceSettings();
  const projects = useProjects();
  const [newWorkspace, setNewWorkspace] = useState(false);
  const onlineCount = machines.data?.filter((machine) => machine.online).length;
  const connection = connectionStatus(realtime.connected, machines.isError ? undefined : onlineCount);
  const links = [
    { to: "/agents", title: t("ui.agents"), icon: Bot },
    { to: "/skills", title: t("parity.skills"), icon: BookOpen },
    { to: "/connections", title: t("phaseB.connections"), icon: Plug },
  ];
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
          <NavLink to="/" onClick={onCloseMobile} className="brand" title={settings.data?.workspaceName ?? "Muster"}>
            <span className="brand-icon">
              <MusterMark size={18} />
            </span>
            <strong>{settings.data?.workspaceName ?? "Muster"}</strong>
          </NavLink>
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
        <div className="sidebar-actions">
          <button onClick={onNewTask} title={t("ui.newTask")} disabled={!projects.data?.length}>
            <Plus size={16} />
            <span>{t("ui.newTask")}</span>
          </button>
        </div>
        <nav aria-label={t("ui.mainNavigation")}>
          <div className="sidebar-heading">{t("ws.workspaces")}</div>
          <div className="topic-list workspace-list">
            {projects.data?.map((project) => {
              const activity = realtime.activity[project.topicId];
              const status = workspaceStatus(project, todos.data ?? [], !!activity && activity.status !== "idle", !!activity?.unread);
              return (
                <NavLink
                  key={project.id}
                  to={`/w/${project.id}`}
                  className={({ isActive }) => `topic-item workspace-item ${isActive ? "active" : ""}`}
                  onClick={onCloseMobile}
                  title={project.name}
                >
                  <ProjectMonogram name={project.name} />
                  <span>{project.name}</span>
                  {status === "running" ? (
                    <LoaderCircle className="spin" size={11} aria-label={t("ui.running")} />
                  ) : (
                    <span className={`topic-status ${status}`} aria-label={label("status", status)} />
                  )}
                </NavLink>
              );
            })}
            <button className="topic-item new-topic" title={t("ws.new")} onClick={() => setNewWorkspace(true)}>
              <Plus size={13} />
              <span>{t("ws.new")}</span>
            </button>
          </div>
          <div className="nav-separator" />
          {links.map(({ to, title, icon: Icon }) => <NavLink className="nav-item" to={to} key={to} title={title} onClick={onCloseMobile}><Icon size={16} /><span>{title}</span></NavLink>)}
        </nav>
        <footer className="sidebar-footer">
          <span
            className={`connection-label ${connection === "offline" ? "warning" : ""}`}
            title={realtime.connected ? t("ui.realtimeConnectionEstablished") : t("ui.reconnectingToServer")}
          >
            <span className={`status-dot ${connection === "online" ? "online" : ""}`} />
            <span>
              {connection === "connecting" ? t("ui.connectingToServer")
                : connection === "unknown" ? t("ui.machineStatusUnavailable")
                : connection === "offline" ? t("ui.noMachinesOnline")
                : t("count.online", { count: onlineCount ?? 0 })}
            </span>
          </span>
          <NavLink className="nav-item" to="/settings" title={t("phaseC.settings")} onClick={onCloseMobile}><Settings size={16} /><span>{t("phaseC.settings")}</span></NavLink>
        </footer>
      </aside>
      {newWorkspace && <WorkspaceDialog onClose={() => { setNewWorkspace(false); onCloseMobile(); }} />}
    </>
  );
}
