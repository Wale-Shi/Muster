import { useI18n, languageNames } from "../i18n";
import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
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
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import type { Topic } from "@muster/shared";
import { api } from "../api/client";
import { useTodos, useTopics } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { useTheme } from "../hooks/usePreferences";
import { isRunning } from "../lib/board";
import { Avatar, Dialog, ErrorNotice } from "./ui";

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
  const { t, locale, setLocale, label } = useI18n();
  const topics = useTopics();
  const todos = useTodos();
  const realtime = useRealtime();
  const theme = useTheme();
  const location = useLocation();
  const [expanded, setExpanded] = useState(true);
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
    { to: "/agents", title: t("ui.agents"), icon: Bot },
    { to: "/projects", title: t("ui.projects"), icon: FolderGit2 },
    { to: "/machines", title: t("ui.machines"), icon: Monitor },
    { to: "/usage", title: t("ui.usage"), icon: BarChart3 },
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
          <NavLink to="/" onClick={onCloseMobile} className="brand">
            <span className="brand-icon">
              <Command size={17} />
            </span>
            <strong>Muster</strong>
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
          <button onClick={onNewTask} title={`${t("ui.newTask")} (N)`}>
            <Plus size={16} />
            <span>{t("ui.newTask")}</span>
            <kbd>N</kbd>
          </button>
        </div>
        <nav aria-label={t("ui.mainNavigation")}>
          <div className="workspace-nav">
            <NavLink
              to="/"
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
              {expanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </button>
          </div>
          {expanded && (
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
                onClick={() => setNewTopic(true)}
              >
                <Plus size={13} />
                <span>{t("ui.newTopic")}</span>
              </button>
            </div>
          )}
          <div className="nav-separator" />
          {links.map(({ to, title, icon: Icon }) => (
            <NavLink
              className="nav-item"
              to={to}
              key={to}
              title={title}
              onClick={onCloseMobile}
            >
              <Icon size={16} />
              <span>{title}</span>
            </NavLink>
          ))}
        </nav>
        <footer className="sidebar-footer">
          <select className="language-picker" aria-label={t("text.language")} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
            {Object.entries(languageNames).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          <div
            className="connection-label"
            title={
              realtime.connected
                ? t("ui.realtimeConnectionEstablished")
                : t("ui.reconnectingToServer")
            }
          >
            <span
              className={`status-dot ${realtime.connected ? "online" : ""}`}
            />
            <span>
              {realtime.connected
                ? t("ui.allSystemsConnected")
                : t("ui.connectingToServer")}
            </span>
          </div>
          <div className="user-row">
            <Avatar name={t("ui.localUser")} small />
            <div>
              <strong>{t("ui.localWorkspace")}</strong>
              <span>{t("ui.selfhostedPersonal")}</span>
            </div>
            <button
              className="icon-button"
              aria-label={t("text.themeChange", { name: t(`theme.${theme.theme}`) })}
              title={t("text.theme", { name: t(`theme.${theme.theme}`) })}
              onClick={theme.cycle}
            >
              {theme.theme === "system" ? (
                <SunMoon size={15} />
              ) : theme.theme === "dark" ? (
                <Moon size={15} />
              ) : (
                <Sun size={15} />
              )}
            </button>
          </div>
        </footer>
      </aside>
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
