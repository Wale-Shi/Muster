import { TopicMenu } from "../components/TopicMenu";
import { useI18n } from "../i18n";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
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
} from "lucide-react";
import type { Todo } from "@muster/shared";
import { useAgents, useProjects, useTodos, useTopics } from "../api/queries";
import { useStored } from "../hooks/usePreferences";
import { Board, TaskCard } from "../components/Board";
import { Conversation } from "../components/Conversation";
import { DoneDialog } from "../components/DoneDialog";
import { Resizable } from "../components/Resizable";
import { ErrorNotice, Loading } from "../components/ui";

export function Workspace({ onNewTask }: { onNewTask: () => void }) {
  const { t } = useI18n();
  const { id } = useParams();
  const topics = useTopics();
  const todos = useTodos();
  const projects = useProjects();
  const agents = useAgents();
  const topic =
    topics.data?.find((item) => item.id === id) ??
    (!id
      ? [...(topics.data ?? [])].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )[0]
      : undefined);
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
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "panel") { setBoardVisible((v) => !v); setMaximized(false); }
      if (command === "maximize") { setBoardVisible(true); setMaximized((v) => !v); setMobileSide("right"); }
    };
    window.addEventListener("muster:shortcut", handler);
    return () => window.removeEventListener("muster:shortcut", handler);
  }, [setBoardVisible]);
  const consumeReference = useCallback(() => setReference(null), []);
  const dragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const todo = todos.data?.find((item) => item.id === event.active.id);
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
  if (topics.isPending) return <Loading />;
  return (
    <div className="workspace page-fill">
      <header className="page-header">
        <div className="breadcrumb">
          <span className="dim">{t("ui.workspace")}</span>
          <span className="dim">/</span>
          <span title={topic?.title}>{topic?.title ?? t("ui.topicNotFound")}</span>
        </div>
        <div className="row">
          {topic && <TopicMenu topic={topic} chiefId={agents.data?.find((a) => a.isChief)?.id} />}
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
          <button
            className="icon-button desktop-only"
            title={`${t("ui.toggleBoard")} (⌘⌥B)`}
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
      <ErrorNotice
        error={topics.error || todos.error || projects.error || agents.error}
      />
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
        onDragStart={(event) =>
          setDragging(
            todos.data?.find((todo) => todo.id === event.active.id) ?? null,
          )
        }
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
                <span className="chief-avatar">✳</span>
                <strong>Chief</strong>
                <span className="muted">{t("ui.yourTeamCoordinated")}</span>
              </div>
              <Conversation
                key={topic?.id ?? "none"}
                conversationId={topic?.id ?? ""}
                status={topic?.activity ?? "idle"}
                runtime={agents.data?.find((agent) => agent.isChief)?.runtime}
                disabled={!topic ? t("ui.createATopicToGetStarted") : undefined}
                reference={reference}
                onReferenceConsumed={consumeReference}
              />
            </div>
          }
          right={
            <Board
              todos={todos.data ?? []}
              projects={projects.data ?? []}
              agents={agents.data ?? []}
              onNew={onNewTask}
            />
          }
        />
        <DragOverlay>
          {dragging ? (
            <TaskCard
              todo={dragging}
              project={projects.data?.find(
                (project) => project.id === dragging.projectId,
              )}
              agent={agents.data?.find(
                (agent) => agent.id === dragging.agentId,
              )}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      {done && <DoneDialog todo={done} onClose={() => setDone(null)} />}
    </div>
  );
}
