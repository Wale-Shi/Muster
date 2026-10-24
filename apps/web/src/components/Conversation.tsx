import { systemMessage } from "../i18n/system";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  ChevronRight,
  Command,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { absolutePath, localPathLinks } from "../lib/localPaths";
import remarkGfm from "remark-gfm";
import type { Message, Todo } from "@muster/shared";
import { QueuedMessages } from "./QueuedMessages";
import { api } from "../api/client";
import { useMessages } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { Avatar, ErrorNotice, Loading } from "./ui";

export function Markdown({ children }: { children: string }) {
  const { t } = useI18n();
  const [pathError, setPathError] = useState<unknown>(null);
  const openPath = (path: string) => { void window.muster?.openPath(path).then((error) => { if (error) setPathError(new Error(error)); }).catch(setPathError); };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={window.muster?.desktop ? [remarkGfm, localPathLinks] : [remarkGfm]}
        urlTransform={(url) => window.muster?.desktop && absolutePath(url) ? url : defaultUrlTransform(url)}
        components={{
          a: ({ href, children }) => {
            const path = window.muster?.desktop && href ? absolutePath(href) : null;
            return path ? <a href={href} title={t("text.open", { path })} onClick={(event) => { event.preventDefault(); openPath(path); }}>{children}</a> : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          code: ({ children, className }) => {
            const path = window.muster?.desktop && !className && typeof children === "string" ? absolutePath(children) : null;
            return path && !path.includes("\n") ? <code><button className="local-path" onClick={() => openPath(path)}>{children}</button></code> : <code className={className}>{children}</code>;
          },
        }}
      >{children}
      </ReactMarkdown>
      <ErrorNotice error={pathError} />
    </div>
  );
}

function ToolGroup({ messages }: { messages: Message[] }) {
  const { t } = useI18n();
  const calls = messages.filter(
    (message) => message.meta.type === "tool.started",
  );
  const reasoningOnly =
    !calls.length &&
    messages.every((message) => message.meta.type === "reasoning.delta");
  return (
    <details className="tool-group">
      <summary>
        <ChevronRight size={12} />
        <Terminal size={13} />
        <span>
          {reasoningOnly
            ? t("ui.thinking")
            : t("count.tools", { count: calls.length || messages.length })}
        </span>
      </summary>
      <div className="tool-lines">
        {messages.map((message) => (
          <div
            key={message.id}
            className={message.meta.error ? "tool-error" : ""}
          >
            <span className="dim">$ </span>
            {typeof message.meta.tool === "string"
              ? message.meta.tool
              : reasoningOnly
                ? t("text.reasoning")
                : t("text.tool")}{" "}
            <span className="muted">
              {message.meta.input !== undefined
                ? JSON.stringify(message.meta.input)
                : message.content}
            </span>
            {message.meta.output !== undefined && (
              <pre>
                {typeof message.meta.output === "string"
                  ? message.meta.output
                  : JSON.stringify(message.meta.output, null, 2)}
              </pre>
            )}
            {typeof message.meta.error === "string" && (
              <pre>{message.meta.error}</pre>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function MessageStream({
  messages,
  agentName,
}: {
  messages: Message[];
  agentName: string;
}) {
  const { t, formatDate, label } = useI18n();
  const groups: (Message | Message[])[] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    if (message.role === "tool") {
      if (Array.isArray(last)) last.push(message);
      else groups.push([message]);
    } else groups.push(message);
  }
  return (
    <>
      {groups.map((item) =>
        Array.isArray(item) ? (
          <ToolGroup key={item[0]?.id} messages={item} />
        ) : item.role === "system" ? (
          <div className="system-message" key={item.id}>
            <span className="system-line" />
            <Markdown>{systemMessage(item, t, label)}</Markdown>
            <span className="system-line" />
          </div>
        ) : (
          <article key={item.id} className={`message ${item.role}`}>
            <div className="message-author">
              <Avatar name={item.role === "user" ? t("ui.you") : agentName} small />
              <strong>{item.role === "user" ? t("ui.you") : agentName}</strong>
              <time dateTime={item.createdAt}>
                {formatDate(item.createdAt, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </div>
            <div className="message-content">
              <Markdown>{item.content}</Markdown>
              {item.meta.streaming === true && (
                <span className="stream-caret" />
              )}
            </div>
          </article>
        ),
      )}
    </>
  );
}

export function Conversation({
  conversationId,
  todoId,
  agentName = "Chief",
  status,
  disabled,
  placeholder,
  reference,
  onReferenceConsumed,
  onDone,
  initialSpec,
}: {
  conversationId: string;
  todoId?: string;
  agentName?: string;
  status?: "queued" | "running" | "idle";
  disabled?: string | undefined;
  placeholder?: string;
  reference?: Todo | null;
  onReferenceConsumed?: () => void;
  onDone?: () => void;
  initialSpec?: string;
}) {
  const { t, label } = useI18n();
  const messages = useMessages(conversationId);
  const realtime = useRealtime();
  const activity = realtime.activity[conversationId];
  const currentStatus = status ?? activity?.status ?? "idle";
  const [text, setText] = useState("");
  const [references, setReferences] = useState<Todo[]>([]);
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { setNodeRef, isOver } = useDroppable({ id: "chat-composer" });
  const send = useMutation({
    mutationFn: async (content: string) => {
      if (todoId) return api.sendTodo(todoId, content);
      return api.sendTopic(conversationId, content);
    },
    onSuccess: () => {
      setText("");
      setReferences([]);
      setFollowing(true);
      textarea.current?.focus();
    },
  });
  useEffect(() => {
    realtime.markRead(conversationId);
  }, [conversationId, activity?.unread, realtime.markRead]);
  useEffect(() => {
    if (reference) {
      setReferences((prior) =>
        prior.some((todo) => todo.id === reference.id)
          ? prior
          : [...prior, reference],
      );
      onReferenceConsumed?.();
      textarea.current?.focus();
    }
  }, [reference, onReferenceConsumed]);
  useEffect(() => {
    if (following) bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.data, following, currentStatus]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (following) bottom.current?.scrollIntoView?.({ block: "end" });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [following]);
  const submit = () => {
    if (
      disabled ||
      !conversationId ||
      send.isPending ||
      (!text.trim() && !references.length)
    )
      return;
    send.mutate(
      [references.map((todo) => `#${todo.number}`).join(" "), text.trim()]
        .filter(Boolean)
        .join(" "),
    );
  };
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (
      (event.metaKey || event.ctrlKey) &&
      event.altKey &&
      event.key === "Enter"
    ) {
      event.preventDefault();
      onDone?.();
    } else if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="conversation">
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (element)
            setFollowing(
              element.scrollHeight - element.scrollTop - element.clientHeight <
                70,
            );
        }}
      >
        {messages.isPending && conversationId ? (
          <Loading />
        ) : messages.isError ? (
          <div className="load-error">
            <ErrorNotice error={messages.error} />
            <button className="button" onClick={() => void messages.refetch()}>
              {t("ui.tryAgain")}
            </button>
          </div>
        ) : !messages.data?.length ? (
          initialSpec ? (
            <article className="message user">
              <div className="message-author">
                <Avatar name={t("ui.you")} small />
                <strong>{t("ui.taskDescription")}</strong>
              </div>
              <Markdown>{initialSpec}</Markdown>
            </article>
          ) : (
            <div className="chief-empty">
              <span className="chief-mark">
                <Command size={24} />
              </span>
              <h1>{t("ui.howCanIHelp")}</h1>
              <p>{t("ui.shareAGoalIllHelpTurnItIntoProgress")}</p>
              <div className="suggestions">
                {[t("ui.planMyNextFeature"), t("ui.whatNeedsMyAttention")].map(
                  (suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        setText(suggestion);
                        textarea.current?.focus();
                      }}
                    >
                      <Sparkles size={13} />
                      {suggestion}
                      <ArrowUp size={13} />
                    </button>
                  ),
                )}
              </div>
            </div>
          )
        ) : (
          <MessageStream messages={messages.data} agentName={agentName} />
        )}
        {currentStatus !== "idle" && (
          <div className="live-status" role="status">
            <span className="pulse-dot" />
            {currentStatus === "queued" ? t("ui.waitingForAMachine") : t("ui.working")}
            {currentStatus === "running" && activity?.detail && (
              <span className="dim">{label("status", activity.detail)}</span>
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {!following && (
        <button
          className="jump-button button"
          onClick={() => {
            setFollowing(true);
            bottom.current?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          <ArrowDown size={13} />
          {t("ui.latestMessages")}
        </button>
      )}
      <div className="composer-wrap">
        <QueuedMessages conversationId={conversationId} />
        {activity?.warning && (
          <div className="runtime-warning" role="alert">
            <AlertTriangle size={14} />
            <span>{activity.warning.detail}</span>
            <button className="icon-button" aria-label={t("ui.dismissRuntimeWarning")} onClick={() => realtime.dismissWarning(conversationId)}><X size={13} /></button>
          </div>
        )}
        <ErrorNotice error={send.error} />
        <div
          ref={setNodeRef}
          className={`composer ${isOver ? "drag-over" : ""}`}
        >
          {isOver && (
            <div className="drop-hint">{t("ui.dropToReferenceThisTask")}</div>
          )}
          {!!references.length && (
            <div className="reference-list">
              {references.map((todo) => (
                <span
                  className="reference-chip"
                  key={todo.id}
                  title={todo.title}
                >
                  #{todo.number}
                  <button
                    onClick={() =>
                      setReferences((prior) =>
                        prior.filter((item) => item.id !== todo.id),
                      )
                    }
                    aria-label={t("text.reference", { number: todo.number })}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label={t("ui.message")}
            value={text}
            rows={3}
            placeholder={
              disabled ?? placeholder ?? t("ui.askChiefOrDropATaskHere")
            }
            disabled={!!disabled || !conversationId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keydown}
          />
          <div className="composer-footer">
            <span className="hint">
              {todoId ? agentName : "Chief"}
              <span className="composer-shortcut"> {t("ui.sendNewLine")}
              </span>
            </span>
            <button
              className="send-button"
              aria-label={t("ui.sendMessage")}
              disabled={
                !!disabled ||
                !conversationId ||
                send.isPending ||
                (!text.trim() && !references.length)
              }
              onClick={submit}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
        <div className="composer-caption">
          {todoId
            ? t("ui.guideTheAgentWithFeedbackAndContext")
            : t("ui.oneConversationAWholeTeamOfAgents")}
        </div>
      </div>
    </div>
  );
}
