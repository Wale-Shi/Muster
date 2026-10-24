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
      realtime.activity[topic.id]?.status === "running" ||
      realtime.activity[topic.id]?.status === "queued" ||
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
    { to: "/agents", title: "Agents", icon: Bot },
    { to: "/projects", title: "Projects", icon: FolderGit2 },
    { to: "/machines", title: "Machines", icon: Monitor },
    { to: "/usage", title: "Usage", icon: BarChart3 },
  ];
  return (
    <>
      <button
        className={`sidebar-scrim ${mobileOpen ? "visible" : ""}`}
        aria-label="Close navigation"
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
            aria-label="Collapse sidebar"
            title="Collapse sidebar (⌘B)"
          >
            <PanelLeftClose size={15} />
          </button>
          <button
            className="icon-button mobile-close"
            onClick={onCloseMobile}
            aria-label="Close sidebar"
          >
            <X size={16} />
          </button>
        </div>
        <div className="sidebar-actions">
          <button onClick={onSearch} title="Search (⌘K)">
            <Search size={16} />
            <span>Search</span>
            <kbd>⌘ K</kbd>
          </button>
          <button onClick={onNewTask} title="New task (N)">
            <Plus size={16} />
            <span>New task</span>
            <kbd>N</kbd>
          </button>
        </div>
        <nav aria-label="Main navigation">
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
              <span>Workspace</span>
            </NavLink>
            <button
              className="icon-button topic-expand"
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "Collapse topics" : "Expand topics"}
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
                        aria-label="Running"
                      />
                    ) : (
                      <span
                        className={`topic-status ${status}`}
                        aria-label={status}
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
                <span>New topic</span>
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
          <div
            className="connection-label"
            title={
              realtime.connected
                ? "Realtime connection established"
                : "Reconnecting to server"
            }
          >
            <span
              className={`status-dot ${realtime.connected ? "online" : ""}`}
            />
            <span>
              {realtime.connected
                ? "All systems connected"
                : "Connecting to server…"}
            </span>
          </div>
          <div className="user-row">
            <Avatar name="Local user" small />
            <div>
              <strong>Local workspace</strong>
              <span>Self-hosted · Personal</span>
            </div>
            <button
              className="icon-button"
              aria-label={`Theme: ${theme.theme}. Click to change`}
              title={`Theme: ${theme.theme}`}
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
    <Dialog title="New topic" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="dialog-body form-stack">
          <label>
            Topic name
            <input
              required
              autoFocus
              value={title}
              placeholder="What are we working on?"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="hint">
            A fresh conversation with Chief, with your workspace in context.
          </p>
          <ErrorNotice error={create.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={create.isPending || !title.trim()}
          >
            <MessageSquare size={13} />
            {create.isPending ? "Creating…" : "Create topic"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
