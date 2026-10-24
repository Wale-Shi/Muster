import { useI18n } from "../i18n";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Coins, PanelRightClose } from "lucide-react";
import { useAgents, useProjects, useTodo } from "../api/queries";
import { Conversation } from "../components/Conversation";
import { DocumentsPanel } from "../components/DocumentsPanel";
import { DoneDialog } from "../components/DoneDialog";
import { Resizable } from "../components/Resizable";
import { TodoActions } from "../components/TodoActions";
import { Avatar, ErrorNotice, Loading, PhaseBadge } from "../components/ui";

export function TodoPage() {
  const { t, formatDuration: duration, formatNumber } = useI18n();
  const number = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const { id = "" } = useParams();
  const query = useTodo(id);
  const projects = useProjects();
  const agents = useAgents();
  const [done, setDone] = useState(false);
  const [panelVisible, setPanelVisible] = useState(true);
  const [mobileSide, setMobileSide] = useState<"left" | "right">("left");
  const todo = query.data;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.key === "Enter" &&
        todo?.phase === "review"
      ) {
        event.preventDefault();
        setDone(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [todo?.phase]);
  if (query.isPending) return <Loading />;
  if (!todo)
    return (
      <div className="page-content">
        <Link className="muted" to="/">
          {t("ui.backToWorkspace")}
        </Link>
        <ErrorNotice error={query.error ?? t("ui.taskNotFound")} />
      </div>
    );
  const build = todo.builds.at(-1);
  const agentId =
    todo.phase === "planning"
      ? (todo.planAgentId ?? todo.agentId)
      : todo.agentId;
  const agent = agents.data?.find((item) => item.id === agentId);
  const project = projects.data?.find((item) => item.id === todo.projectId);
  const tokensIn = todo.builds.reduce((sum, item) => sum + item.tokensIn, 0);
  const tokensOut = todo.builds.reduce((sum, item) => sum + item.tokensOut, 0);
  const ms = todo.builds.reduce((sum, item) => sum + item.durationMs, 0);
  const status =
    todo.phase === "queued"
      ? "queued"
      : ["planning", "building"].includes(todo.phase)
        ? "running"
        : "idle";
  const canMessage = ["queued", "planning", "building", "confirm", "review"].includes(
    todo.phase,
  );
  return (
    <div className="page-fill todo-page">
      <header className="todo-header">
        <div className="todo-title-row">
          <Link
            to={todo.topicId ? `/topics/${todo.topicId}` : "/"}
            className="icon-button"
            aria-label={t("ui.backToWorkspace")}
          >
            <ArrowLeft size={16} />
          </Link>
          <span className="mono dim">#{todo.number}</span>
          <h1>{todo.title}</h1>
          <button
            className="icon-button desktop-only"
            aria-label={t("ui.toggleDocumentsPanel")}
            onClick={() => setPanelVisible(!panelVisible)}
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="todo-metadata">
          <PhaseBadge phase={todo.phase} />
          <span className="metadata-divider" />
          <span className="project-tag">
            <span className="project-square" />
            {project?.name ?? t("ui.project")}
          </span>
          {agent && (
            <span className="row muted">
              <Avatar name={agent.name} small />
              {agent.name}
            </span>
          )}
          <details className="usage-popover">
            <summary className="button ghost">
              <Coins size={13} />
              {t("text.tokens", { count: tokensIn + tokensOut })}
            </summary>
            <div className="popover">
              <strong>{t("ui.buildUsage")}</strong>
              <span>
                {t("ui.input")}<b>{number(tokensIn)}</b>
              </span>
              <span>
                {t("ui.output")}<b>{number(tokensOut)}</b>
              </span>
              <span>
                {t("ui.duration")}<b>{duration(ms)}</b>
              </span>
              <span>
                {t("ui.builds")}<b>{number(todo.builds.length)}</b>
              </span>
            </div>
          </details>
          <div className="spacer" />
          <TodoActions todo={todo} onDone={() => setDone(true)} />
        </div>
        <div className="mobile-panel-tabs">
          <button
            className={mobileSide === "left" ? "active" : ""}
            onClick={() => setMobileSide("left")}
          >
            {t("ui.conversation")}
          </button>
          <button
            className={mobileSide === "right" ? "active" : ""}
            onClick={() => {
              setMobileSide("right");
              setPanelVisible(true);
            }}
          >
            {t("ui.planChanges")}
          </button>
        </div>
      </header>
      <ErrorNotice error={query.error} />
      <Resizable
        storageKey="todo-width"
        initial={58}
        hidden={!panelVisible}
        mobileSide={mobileSide}
        onSwipe={setMobileSide}
        left={
          <Conversation
            key={build?.id ?? todo.id}
            conversationId={build?.id ?? ""}
            todoId={todo.id}
            agentName={agent?.name ?? t("ui.agent")}
            status={status}
            disabled={
              canMessage
                ? undefined
                : todo.phase === "todo"
                  ? t("ui.startThisTaskToBeginTheConversation")
                  : todo.phase === "queued"
                    ? t("ui.waitingForAMachineToStartThisTurn")
                    : t("ui.reopenOrRerunThisTaskToContinue")
            }
            initialSpec={todo.spec}
            placeholder={t("ui.sendFeedbackToYourAgent")}
            onDone={() => {
              if (todo.phase === "review") setDone(true);
            }}
          />
        }
        right={<DocumentsPanel key={todo.id} todo={todo} />}
      />
      {done && <DoneDialog todo={todo} onClose={() => setDone(false)} />}
    </div>
  );
}
