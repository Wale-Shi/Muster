import { useI18n } from "../i18n";
import { useCallback, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  Columns3,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRightClose,
  Settings,
} from "lucide-react";
import type { Todo } from "@muster/shared";
import { useAgents, useProject, useProjects, useTodos, useTopic } from "../api/queries";
import { useStored } from "../hooks/usePreferences";
import { Board, TaskCard } from "../components/Board";
import { Conversation } from "../components/Conversation";
import { DoneDialog } from "../components/DoneDialog";
import { Resizable } from "../components/Resizable";
import { Avatar, ErrorNotice, Loading } from "../components/ui";
import { WorkspaceEmpty } from "./Workspaces";

/** `/` opens the first workspace, or offers to create one. */
export function Home() {
  const projects = useProjects();
  if (projects.isPending) return <Loading />;
  const first = projects.data?.[0];
  return first ? <Navigate replace to={`/w/${first.id}`} /> : <WorkspaceEmpty error={projects.error} />;
}

/** One workspace: its master agent's conversation beside the workspace's task board. */
export function Workspace({ onNewTask }: { onNewTask: () => void }) {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const project = useProject(id);
  const topic = useTopic(project.data?.topicId);
  const todos = useTodos();
  const agents = useAgents();
  const master = agents.data?.find((agent) => agent.id === project.data?.chiefAgentId) ?? agents.data?.find((agent) => agent.isChief);
  const tasks = todos.data?.filter((todo) => todo.projectId === id) ?? [];
  const [boardVisible, setBoardVisible] = useStored("board-visible", true);
  const [maximized, setMaximized] = useState(false);
  const [mobileSide, setMobileSide] = useState<"left" | "right">(() => window.matchMedia("(min-width: 768px) and (max-width: 1050px)").matches ? "right" : "left");
  const [dragging, setDragging] = useState<Todo | null>(null);
  const [reference, setReference] = useState<Todo | null>(null);
  const [done, setDone] = useState<Todo | null>(null);
  const [notice, setNotice] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const consumeReference = useCallback(() => setReference(null), []);
  const dragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const todo = tasks.find((item) => item.id === event.active.id);
    if (!todo) return;
    if (event.over?.id === "chat-composer") setReference(todo);
    if (event.over?.id === "column-done") {
      if (todo.phase === "review") setDone(todo);
      else {
        setNotice(true);
        setTimeout(() => setNotice(false), 5000);
      }
    }
  };
  if (project.isPending) return <Loading />;
  if (!project.data) return <div className="page-content"><ErrorNotice error={project.error ?? t("ws.notFound")} /></div>;
  const workspace = project.data;
  return (
    <div className="workspace page-fill">
      <header className="page-header">
        <div className="breadcrumb">
          <span title={workspace.name}><strong>{workspace.name}</strong></span>
          <span className="chip mono" title={workspace.repoUrl}>{workspace.baseBranch}</span>
        </div>
        <div className="row">
          <div className="mobile-panel-tabs">
            <button
              className={mobileSide === "left" ? "active" : ""}
              onClick={() => setMobileSide("left")}
            >
              <MessageSquare size={14} />
              {t("ui.chat")}
            </button>
            <button
              className={mobileSide === "right" ? "active" : ""}
              onClick={() => {
                setBoardVisible(true);
                setMobileSide("right");
              }}
            >
              <Columns3 size={14} />
              {t("ui.board")}
            </button>
          </div>
          <Link className="icon-button" to={`/w/${workspace.id}/settings`} aria-label={t("ws.settings")} title={t("ws.settings")}>
            <Settings size={15} />
          </Link>
          <button
            className="icon-button desktop-only"
            title={t("ui.toggleBoard")}
            aria-label={t("ui.toggleBoard")}
            onClick={() => {
              setBoardVisible((prior) => !prior);
              setMaximized(false);
            }}
          >
            <PanelRightClose size={16} />
          </button>
          <button
            className="icon-button desktop-only"
            aria-label={maximized ? t("ui.restoreSplitView") : t("ui.maximizeBoard")}
            onClick={() => {
              setBoardVisible(true);
              setMaximized(!maximized);
            }}
          >
            {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </header>
      <ErrorNotice error={topic.error || todos.error || agents.error} />
      {notice && (
        <div className="notice" role="status">
          {t("ui.tasksMustReachReviewBeforeTheyCanBeMarkedDone")}
        </div>
      )}
      <DndContext
        accessibility={{
          screenReaderInstructions: { draggable: t("text.dragInstructions") },
          announcements: {
            onDragStart: () => t("text.dragStarted"),
            onDragOver: ({ over }) => t(over ? "text.dragOver" : "text.dragOutside"),
            onDragEnd: () => t("text.dragEnd"),
            onDragCancel: () => t("text.dragCancel"),
          },
        }}
        sensors={sensors}
        collisionDetection={(args) => {
          const pointer = pointerWithin(args);
          return pointer.length ? pointer : rectIntersection(args);
        }}
        onDragStart={(event) => setDragging(tasks.find((todo) => todo.id === event.active.id) ?? null)}
        onDragEnd={dragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <Resizable
          storageKey="workspace-width"
          initial={40}
          hidden={!boardVisible}
          maximized={maximized}
          mobileSide={mobileSide}
          onSwipe={setMobileSide}
          left={
            <div className="conversation-panel">
              <div className="panel-heading">
                <Avatar name={master?.name ?? "Chief"} small />
                <strong>{master?.name ?? "Chief"}</strong>
                <span className="muted">{t("ws.masterOf", { name: workspace.name })}</span>
                {master && <Link className="link panel-heading-action" to={`/agents/${master.id}`}>{t("ws.masterSettings")}</Link>}
              </div>
              <Conversation
                key={workspace.topicId}
                conversationId={workspace.topicId}
                agentName={master?.name ?? "Chief"}
                status={topic.data?.activity ?? "idle"}
                runtime={master?.runtime}
                reference={reference}
                onReferenceConsumed={consumeReference}
              />
            </div>
          }
          right={<Board todos={tasks} agents={agents.data ?? []} onNew={onNewTask} />}
        />
        <DragOverlay>
          {dragging ? (
            <TaskCard todo={dragging} agent={agents.data?.find((agent) => agent.id === dragging.agentId)} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>
      {done && <DoneDialog todo={done} onClose={() => setDone(null)} />}
    </div>
  );
}
