import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation, useParams } from "react-router";
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
  const [collapsed, setCollapsed] = useStored("sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const location = useLocation();
  const toggleSidebar = () => {
    if (window.innerWidth < 768) setMobileOpen((prior) => !prior);
    else setCollapsed((prior) => !prior);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const editing =
        event.target instanceof HTMLElement &&
        !!event.target.closest(
          'input, textarea, select, [contenteditable="true"]',
        );
      const dialogOpen = !!document.querySelector("dialog[open]");
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyK") {
        event.preventDefault();
        if (!dialogOpen || search) setSearch((prior) => !prior);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.code === "KeyB"
      ) {
        event.preventDefault();
        if (window.innerWidth < 768) setMobileOpen((prior) => !prior);
        else setCollapsed((prior) => !prior);
      }
      if (
        event.code === "KeyN" &&
        !editing &&
        !dialogOpen &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setNewTask(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [setCollapsed, search]);
  return (
    <div className={`app ${collapsed ? "sidebar-is-collapsed" : ""} ${window.muster?.desktop ? "muster-desktop" : ""} ${window.muster?.platform === "darwin" ? "muster-mac" : ""}`} >
      <DesktopIntegration onNewTask={() => setNewTask(true)} />
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggle={toggleSidebar}
        onCloseMobile={() => setMobileOpen(false)}
        onSearch={() => setSearch(true)}
        onNewTask={() => setNewTask(true)}
      />
      <main className="main">
        <div className="mobile-topbar">
          <button
            className="icon-button"
            onClick={toggleSidebar}
            aria-label="Open navigation"
          >
            <PanelLeft size={18} />
          </button>
          <Command size={16} />
          <strong>Muster</strong>
        </div>
        {collapsed && (
          <button
            className="sidebar-restore icon-button desktop-only"
            aria-label="Expand sidebar"
            title="Expand sidebar (⌘B)"
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
          <Route path="/agents" element={<Agents />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/usage" element={<Usage />} />
          <Route
            path="*"
            element={
              <div className="empty">
                <h2>Page not found</h2>
                <Link to="/" className="button">
                  Back to workspace
                </Link>
              </div>
            }
          />
        </Routes>
      </main>
      {search && <CommandPalette onClose={() => setSearch(false)} />}
      {newTask && (
        <Routes>
          <Route
            path="/topics/:id"
            element={<NewTaskRouteDialog onClose={() => setNewTask(false)} />}
          />
          <Route
            path="*"
            element={<NewTaskDialog onClose={() => setNewTask(false)} />}
          />
        </Routes>
      )}
    </div>
  );
}
