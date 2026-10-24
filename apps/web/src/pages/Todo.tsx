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
import { duration, number } from "../lib/format";

export function TodoPage() {
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
          ← Back to workspace
        </Link>
        <ErrorNotice error={query.error ?? "Task not found"} />
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
            aria-label="Back to workspace"
          >
            <ArrowLeft size={16} />
          </Link>
          <span className="mono dim">#{todo.number}</span>
          <h1>{todo.title}</h1>
          <button
            className="icon-button desktop-only"
            aria-label="Toggle documents panel"
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
            {project?.name ?? "Project"}
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
              {number(tokensIn + tokensOut)} tokens
            </summary>
            <div className="popover">
              <strong>Build usage</strong>
              <span>
                Input <b>{number(tokensIn)}</b>
              </span>
              <span>
                Output <b>{number(tokensOut)}</b>
              </span>
              <span>
                Duration <b>{duration(ms)}</b>
              </span>
              <span>
                Builds <b>{todo.builds.length}</b>
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
            Conversation
          </button>
          <button
            className={mobileSide === "right" ? "active" : ""}
            onClick={() => {
              setMobileSide("right");
              setPanelVisible(true);
            }}
          >
            Plan & changes
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
            agentName={agent?.name ?? "Agent"}
            status={status}
            disabled={
              canMessage
                ? undefined
                : todo.phase === "todo"
                  ? "Start this task to begin the conversation"
                  : todo.phase === "queued"
                    ? "Waiting for a machine to start this turn…"
                    : "Reopen or rerun this task to continue"
            }
            initialSpec={todo.spec}
            placeholder="Send feedback to your agent…"
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
