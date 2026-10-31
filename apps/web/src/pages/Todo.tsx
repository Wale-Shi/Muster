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
  const [maximized, setMaximized] = useState(false);
  const [panelVisible, setPanelVisible] = useState(true);
  const [mobileSide, setMobileSide] = useState<"left" | "right">("left");
  const todo = query.data;
  useEffect(() => {
    const handler = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "complete" && todo?.phase === "review") setDone(true);
      if (command === "panel") { setPanelVisible((v) => !v); setMaximized(false); }
      if (command === "maximize") { setPanelVisible(true); setMaximized((v) => !v); setMobileSide("right"); }
    };
    window.addEventListener("muster:shortcut", handler);
    return () => window.removeEventListener("muster:shortcut", handler);
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
  const agent = agents.data?.find((item) => item.id === todo.agentId);
  const runtime = agent?.runtime;
  const project = projects.data?.find((item) => item.id === todo.projectId);
  const tokensIn = todo.builds.reduce((sum, item) => sum + item.tokensIn, 0);
  const tokensOut = todo.builds.reduce((sum, item) => sum + item.tokensOut, 0);
  const ms = todo.builds.reduce((sum, item) => sum + item.durationMs, 0);
  const status =
    todo.phase === "queued"
      ? "queued"
      : todo.phase === "building"
        ? "running"
        : "idle";
  const canMessage = ["queued", "building", "review"].includes(todo.phase);
  return (
    <div className="page-fill todo-page">
      <header className="todo-header">
        <div className="todo-title-row">
          <Link
            to={`/w/${todo.projectId}`}
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
          <Link className="project-tag" title={project?.name} to={`/w/${todo.projectId}`}>
            <span className="project-square" />
            {project?.name ?? t("ws.workspace")}
          </Link>
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
            {t("ui.changes")}
          </button>
        </div>
      </header>
      <ErrorNotice error={query.error} />
      <Resizable maximized={maximized}
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
            runtime={runtime}
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
            placeholder={todo.phase === "review" ? t("ws.reviewFeedback") : t("ui.sendFeedbackToYourAgent")}
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
