import { SettingsPage } from "./pages/Settings";
import { ConnectionsPage } from "./pages/Connections";
import { AgentPage } from "./pages/Agent";
import { SkillsPage, NewSkillPage, SkillPage } from "./pages/Skills";
import { useI18n } from "./i18n";
import { useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router";
import { Command, PanelLeft } from "lucide-react";
import { DesktopIntegration } from "./components/DesktopIntegration";
import { Sidebar } from "./components/Sidebar";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { useStored } from "./hooks/usePreferences";
import { Home, Workspace } from "./pages/Workspace";
import { WorkspaceSettingsPage } from "./pages/Workspaces";
import { TodoPage } from "./pages/Todo";
import { Agents } from "./pages/Agents";

function LegacyProjectRedirect() {
  const { id = "" } = useParams();
  return <Navigate replace to={`/w/${id}`} />;
}
export function App() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useStored("sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const location = useLocation();
  const toggleSidebar = () => {
    if (window.innerWidth < 768) setMobileOpen((prior) => !prior);
    else setCollapsed((prior) => !prior);
  };
  return (
    <div className={`app ${collapsed ? "sidebar-is-collapsed" : ""} ${window.muster?.desktop ? "muster-desktop" : ""} ${window.muster?.platform === "darwin" ? "muster-mac" : ""}`} >
      <DesktopIntegration onNewTask={() => setNewTask(true)} />
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
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
            title={t("ui.expandSidebar")}
            onClick={toggleSidebar}
          >
            <PanelLeft size={16} />
          </button>
        )}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/w/:id" element={<Workspace key={location.pathname} onNewTask={() => setNewTask(true)} />} />
          <Route path="/w/:id/settings" element={<WorkspaceSettingsPage key={location.pathname} />} />
          <Route path="/todos/:id" element={<TodoPage key={location.pathname} />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentPage key={location.pathname} />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/skills/new" element={<NewSkillPage />} />
          <Route path="/skills/:slug" element={<SkillPage key={location.pathname} />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/projects/:id" element={<LegacyProjectRedirect />} />
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
      {newTask && (
        <NewTaskDialog
          initialProjectId={location.pathname.match(/^\/w\/([^/]+)/)?.[1]}
          onClose={() => setNewTask(false)}
        />
      )}
    </div>
  );
}
