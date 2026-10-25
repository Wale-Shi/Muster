import { useWorkspaceSettings } from "../pages/Settings";
import { ProjectDialog } from "../pages/Projects";
import { ProjectMonogram } from "./ProjectMonogram";
import { useI18n } from "../i18n";
import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Clock,
  Plug,
  KeyRound,
  BarChart3,
  Bot,
  ChevronDown,
  ChevronRight,
  Command,
  FolderGit2,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Monitor,
  Settings,
  PanelLeftClose,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { Topic } from "@muster/shared";
import { api } from "../api/client";
import { useTodos, useTopics, useMachines, useProjects } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { useStored } from "../hooks/usePreferences";
import { isRunning } from "../lib/board";
import { Dialog, ErrorNotice } from "./ui";

export function connectionStatus(connected: boolean, onlineCount: number | undefined) {
  if (!connected) return "connecting";
  if (onlineCount === undefined) return "unknown";
  return onlineCount > 0 ? "online" : "offline";
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onCloseMobile,
  onSearch,
  onNewTask,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onCloseMobile: () => void;
  onSearch: () => void;
  onNewTask: () => void;
}) {
  const { t, label } = useI18n();
  const topics = useTopics();
  const machines = useMachines();
  const todos = useTodos();
  const realtime = useRealtime();
  const settings = useWorkspaceSettings();
  const projects = useProjects();
  const [projectsOpen, setProjectsOpen] = useStored("projects-expanded", true);
  const [resourcesOpen, setResourcesOpen] = useStored("resources-expanded", true);
  const [newProject, setNewProject] = useState(false);
  const onlineCount = machines.data?.filter((machine) => machine.online).length;
  const connection = connectionStatus(realtime.connected, machines.isError ? undefined : onlineCount);
  const location = useLocation();
  const [expanded, setExpanded] = useStored("topics-expanded", true);
  const [newTopic, setNewTopic] = useState(false);
  const defaultTopic = [...(topics.data ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )[0]?.id;
  const activityFor = (topic: Topic) => {
    const linked =
      todos.data?.filter(
        (todo) =>
          todo.topicId === topic.id ||
          (!todo.topicId && topic.id === defaultTopic),
      ) ?? [];
    if (
      topic.activity === "running" ||
      topic.activity === "queued" ||
      linked.some((todo) => isRunning(todo.phase))
    )
      return "running";
    if (linked.some((todo) => todo.phase === "failed")) return "failed";
    if (linked.some((todo) => ["confirm", "review"].includes(todo.phase)))
      return "needs-you";
    if (realtime.activity[topic.id]?.unread) return "unread";
    return "idle";
  };
  const links = [
    { to: "/schedules", title: t("phaseB.schedules"), icon: Clock },
    { to: "/connections", title: t("phaseB.connections"), icon: Plug },
    { to: "/skills", title: t("parity.skills"), icon: BookOpen },

    { to: "/usage", title: t("ui.usage"), icon: BarChart3 },
    { to: "/agents", title: t("ui.agents"), icon: Bot },
    { to: "/machines", title: t("ui.machines"), icon: Monitor },
    { to: "/secrets", title: t("parity.secrets"), icon: KeyRound },
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
          <NavLink to="/agents" onClick={onCloseMobile} className="brand" title={settings.data?.workspaceName ?? "Muster"}>
            <span className="brand-icon">
              <Command size={17} />
            </span>
            <strong>{settings.data?.workspaceName ?? "Muster"}</strong>
            <ChevronDown size={13} className="dim" />
          </NavLink>
          <button
            className="icon-button collapse-control"
            onClick={onToggle}
            aria-label={t("ui.collapseSidebar")}
            title={`${t("ui.collapseSidebar")} (⌘B)`}
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
          <button onClick={onSearch} title={`${t("ui.search")} (⌘K)`}>
            <Search size={16} />
            <span>{t("ui.search")}</span>
            <kbd>⌘ K</kbd>
          </button>
          <button onClick={onNewTask} title={`${t("ui.newTask")} (⌘N)`}>
            <Plus size={16} />
            <span>{t("ui.newTask")}</span>
            <kbd>⌘ N</kbd>
          </button>
        </div>
        <nav aria-label={t("ui.mainNavigation")}>
          <div className="workspace-nav">
            <NavLink
              to="/"
              title={t("ui.workspace")}
              className={
                location.pathname === "/" ||
                location.pathname.startsWith("/topics/")
                  ? "nav-item active"
                  : "nav-item"
              }
              onClick={onCloseMobile}
            >
              <LayoutDashboard size={16} />
              <span>{t("ui.workspace")}</span>
            </NavLink>
            <button
              className="icon-button topic-expand"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? t("ui.collapseTopics") : t("ui.expandTopics")}
              aria-expanded={expanded}
            >
              <ChevronRight size={12} className={`sidebar-chevron ${expanded ? "expanded" : ""}`} />
            </button>
          </div>
          {(expanded || collapsed) && (
            <div className="topic-list">
              {topics.data?.map((topic) => {
                const status = activityFor(topic);
                return (
                  <NavLink
                    key={topic.id}
                    to={`/topics/${topic.id}`}
                    className={({ isActive }) =>
                      `topic-item ${isActive || (location.pathname === "/" && topic.id === defaultTopic) ? "active" : ""}`
                    }
                    onClick={onCloseMobile}
                    title={topic.title}
                  >
                    {status === "running" ? (
                      <LoaderCircle
                        className="spin"
                        size={11}
                        aria-label={t("ui.running")}
                      />
                    ) : (
                      <span
                        className={`topic-status ${status}`}
                        aria-label={label("status", status)}
                      />
                    )}
                    <span>{topic.title}</span>
                  </NavLink>
                );
              })}
              <button
                className="topic-item new-topic"
                title={t("ui.newTopic")}
                onClick={() => setNewTopic(true)}
              >
                <Plus size={13} />
                <span>{t("ui.newTopic")}</span>
              </button>
            </div>
          )}
          <div className="nav-separator" />
          {links.slice(0, 4).map(({ to, title, icon: Icon }) => <NavLink className="nav-item" to={to} key={to} title={title} onClick={onCloseMobile}><Icon size={16} /><span>{title}</span></NavLink>)}
          <div className="workspace-nav"><NavLink className="nav-item" to="/projects" title={t("ui.projects")} onClick={onCloseMobile}><FolderGit2 size={16} /><span>{t("ui.projects")}</span></NavLink><button className="icon-button topic-expand" aria-label={t("ui.projects")} aria-expanded={projectsOpen} onClick={() => setProjectsOpen(!projectsOpen)}><ChevronRight size={12} className={`sidebar-chevron ${projectsOpen ? "expanded" : ""}`} /></button></div>
          {(projectsOpen || collapsed) && <div className="sidebar-group">{projects.data?.map((p) => <NavLink className="nav-item" key={p.id} to={`/projects/${p.id}`} title={p.name} onClick={onCloseMobile}><ProjectMonogram name={p.name} /><span>{p.name}</span></NavLink>)}<button className="nav-item" title={t("ui.newProject")} onClick={() => setNewProject(true)}><Plus size={16} /><span>{t("ui.newProject")}</span></button></div>}
          <button className="nav-item" title={t("parity.resources")} aria-expanded={resourcesOpen} onClick={() => setResourcesOpen(!resourcesOpen)}><ChevronRight size={16} className={`sidebar-chevron ${resourcesOpen ? "expanded" : ""}`} /><span>{t("parity.resources")}</span></button>
          {(resourcesOpen || collapsed) && links.slice(4).map(({ to, title, icon: Icon }) => <NavLink className="nav-item" to={to} key={to} title={title} onClick={onCloseMobile}><Icon size={16} /><span>{title}</span></NavLink>)}
        </nav>
        <footer className="sidebar-footer">
          <div
            className={`connection-label ${connection === "offline" ? "warning" : ""}`}
            title={
              realtime.connected
                ? t("ui.realtimeConnectionEstablished")
                : t("ui.reconnectingToServer")
            }
          >
            <span
              className={`status-dot ${connection === "online" ? "online" : ""}`}
            />
            <span>
              {connection === "connecting" ? t("ui.connectingToServer")
                : connection === "unknown" ? t("ui.machineStatusUnavailable")
                : connection === "offline" ? t("ui.noMachinesOnline")
                : t("count.online", { count: onlineCount ?? 0 })}
            </span>
          </div>
          <NavLink className="nav-item" to="/settings" title={`${t("phaseC.settings")} (⌘,)`} onClick={onCloseMobile}><Settings size={16} /><span>{t("phaseC.settings")}</span><kbd>⌘,</kbd></NavLink>
          <div className="user-row" title={t("ui.localWorkspace")}>
            <span className="avatar small" aria-hidden="true"><Command size={13} /></span>
            <div>
              <strong title={t("ui.localWorkspace")}>{t("ui.localWorkspace")}</strong>
              <span>{t("ui.selfhostedPersonal")}</span>
            </div>
          </div>
        </footer>
      </aside>
      {newProject && <ProjectDialog onClose={() => setNewProject(false)} />}
      {newTopic && (
        <NewTopicDialog
          onClose={() => {
            setNewTopic(false);
            onCloseMobile();
          }}
        />
      )}
    </>
  );
}
function NewTopicDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createTopic(title.trim()),
    onSuccess: (topic) => {
      void client.invalidateQueries({ queryKey: ["topics"] });
      void navigate(`/topics/${topic.id}`);
      onClose();
    },
  });
  return (
    <Dialog title={t("ui.newTopic")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="dialog-body form-stack">
          <label>
            {t("ui.topicName")}<input
              required
              autoFocus
              value={title}
              placeholder={t("ui.whatAreWeWorkingOn")}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="hint">
            {t("ui.aFreshConversationWithChiefWithYourWorkspaceInContext")}
          </p>
          <ErrorNotice error={create.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            {t("ui.cancel")}
          </button>
          <button
            className="button primary"
            disabled={create.isPending || !title.trim()}
          >
            <MessageSquare size={13} />
            {create.isPending ? t("ui.creating") : t("ui.createTopic")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
