import { SettingsPage, ShortcutsDialog } from "./pages/Settings";
import { matchShortcut, dispatchShortcut } from "./lib/shortcuts";
import { ProjectPage, ProjectSettingsPage } from "./pages/Project";
import { SchedulesPage } from "./pages/Schedules";
import { ConnectionsPage } from "./pages/Connections";
import { AgentPage } from "./pages/Agent";
import { SkillsPage, NewSkillPage, SkillPage } from "./pages/Skills";
import { SecretsPage } from "./pages/Secrets";
import { useI18n } from "./i18n";
import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Command, PanelLeft } from "lucide-react";
import { DesktopIntegration } from "./components/DesktopIntegration";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { useStored } from "./hooks/usePreferences";
import { Workspace } from "./pages/Workspace";
import { TodoPage } from "./pages/Todo";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";
import { Machines } from "./pages/Machines";
import { Usage } from "./pages/Usage";

function NewTaskRouteDialog({ onClose }: { onClose: () => void }) {
  const { id } = useParams();
  return <NewTaskDialog onClose={onClose} {...(id ? { topicId: id } : {})} />;
}
export function App() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useStored("sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const [newTask, setNewTask] = useState(false);
  const location = useLocation();
  const toggleSidebar = () => {
    if (window.innerWidth < 768) setMobileOpen((prior) => !prior);
    else setCollapsed((prior) => !prior);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const shortcut = matchShortcut(event); if (!shortcut) return;
      const dialogOpen = !!document.querySelector("dialog[open]");
      if (shortcut.command === "close") return; // Native dialog cancel handles Escape.
      if (dialogOpen && shortcut.command !== "shortcuts") return;
      event.preventDefault();
      switch (shortcut.command) {
        case "searchAll": setSearch(0); break;
        case "searchTasks": setSearch(1); break;
        case "searchTopics": setSearch(2); break;
        case "newTask": setNewTask(true); break;
        case "sidebar": toggleSidebar(); break;
        case "back": navigate(-1); break;
        case "settings": navigate("/settings"); break;
        case "shortcuts": setHelp((prior) => !prior); break;
        default: dispatchShortcut(shortcut.command);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [setCollapsed, search, navigate]);
  return (
    <div className={`app ${collapsed ? "sidebar-is-collapsed" : ""} ${window.muster?.desktop ? "muster-desktop" : ""} ${window.muster?.platform === "darwin" ? "muster-mac" : ""}`} >
      <DesktopIntegration onNewTask={() => setNewTask(true)} onShortcuts={() => setHelp(true)} />
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
        onSearch={() => setSearch(0)}
        onNewTask={() => setNewTask(true)}
      />
      <main className="main">
        <div className="mobile-topbar">
          <button
            className="icon-button"
            onClick={toggleSidebar}
            aria-label={t("ui.openNavigation")}
          >
            <PanelLeft size={18} />
          </button>
          <Command size={16} />
          <strong>Muster</strong>
        </div>
        {collapsed && (
          <button
            className="sidebar-restore icon-button desktop-only"
            aria-label={t("ui.expandSidebar")}
            title={`${t("ui.expandSidebar")} (⌘B)`}
            onClick={toggleSidebar}
          >
            <PanelLeft size={16} />
          </button>
        )}
        <Routes>
          <Route
            path="/"
            element={<Workspace onNewTask={() => setNewTask(true)} />}
          />
          <Route
            path="/topics/:id"
            element={<Workspace onNewTask={() => setNewTask(true)} />}
          />
          <Route
            path="/todos/:id"
            element={<TodoPage key={location.pathname} />}
          />
          <Route path="/agents/:id" element={<AgentPage key={location.pathname} />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/skills/new" element={<NewSkillPage />} />
          <Route path="/skills/:slug" element={<SkillPage key={location.pathname} />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/secrets" element={<SecretsPage />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectPage key={location.pathname} />} />
          <Route path="/projects/:id/settings" element={<ProjectSettingsPage key={location.pathname} />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/usage" element={<Usage />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <h2>{t("ui.pageNotFound")}</h2>
                <Link to="/" className="button">
                  {t("ui.backToWorkspace")}
                </Link>
              </div>
            }
          />
        </Routes>
      </main>
      {search !== null && <CommandPalette initialTab={search} onClose={() => setSearch(null)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {newTask && (
        <Routes>
          <Route
            path="/topics/:id"
            element={<NewTaskRouteDialog onClose={() => setNewTask(false)} />}
          />
          <Route
            path="*"
            element={<NewTaskDialog initialProjectId={location.pathname.match(/^\/projects\/([^/]+)/)?.[1]} onClose={() => setNewTask(false)} />}
          />
        </Routes>
      )}
    </div>
  );
}
