import { LocalImage, type ImageContext } from "./LocalImage";
import { useNavigate } from "react-router";
import { MentionInput } from "./MentionInput";
import { systemMessage } from "../i18n/system";
import { useI18n } from "../i18n";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import {
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  BookOpen,
  ChevronRight,
  ClipboardCheck,
  Command,
  ListChecks,
  Split,
  Terminal,
  X,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { absolutePath, localPathLinks } from "../lib/localPaths";
import remarkGfm from "remark-gfm";
import type { Message, Runtime, Todo } from "@muster/shared";
import { QueuedMessages } from "./QueuedMessages";
import { api } from "../api/client";
import { useMachines, useMessages } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { Avatar, ErrorNotice, Loading } from "./ui";

const isLocalImage = (value: unknown): value is string => typeof value === "string" && Boolean(absolutePath(value) || /^(file:|muster-local:)/.test(value));

export function Markdown({ children, imageContext }: { children: string; imageContext?: ImageContext | undefined }) {
  const { t } = useI18n();
  const [pathError, setPathError] = useState<unknown>(null);
  const openPath = (path: string) => { void window.muster?.openPath(path).then((error) => { if (error) setPathError(new Error(error)); }).catch(setPathError); };
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={window.muster?.desktop ? [remarkGfm, localPathLinks] : [remarkGfm]}
        urlTransform={(url, key) => (key === "src" && isLocalImage(url)) || (window.muster?.desktop && absolutePath(url)) ? url : defaultUrlTransform(url)}
        components={{
          img: ({ src, alt }) => isLocalImage(src) ? <LocalImage src={src} alt={alt} context={imageContext} /> : <img src={src} alt={alt} />,
          a: ({ href, children, node }) => {
            const containsLocalImage = (element: typeof node): boolean => Boolean(element?.children.some((child) => child.type === "element" && (child.tagName === "img" && isLocalImage(child.properties.src) || containsLocalImage(child))));
            // An image wrapped in a link must not reopen a denied path via mouse or keyboard.
            if (containsLocalImage(node)) return <span>{children}</span>;
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
  todoId,
}: {
  todoId?: string | undefined;
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
              <Markdown imageContext={todoId && item.role === "agent" ? { todoId, buildId: item.conversationId, messageId: item.id, streaming: item.meta.streaming === true } : undefined}>{item.content}</Markdown>
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
  agentName = "Master agent",
  status,
  runtime,
  disabled,
  placeholder,
  reference,
  onReferenceConsumed,
  onDone,
  initialSpec,
}: {
  conversationId: string;
  todoId?: string | undefined;
  agentName?: string;
  status?: "queued" | "running" | "idle";
  runtime?: Runtime | undefined;
  disabled?: string | undefined;
  placeholder?: string;
  reference?: Todo | null;
  onReferenceConsumed?: () => void;
  onDone?: () => void;
  initialSpec?: string;
}) {
  const { t, label } = useI18n();
  const messages = useMessages(conversationId);
  const machines = useMachines();
  const realtime = useRealtime();
  const activity = realtime.activity[conversationId];
  const currentStatus = status ?? activity?.status ?? "idle";
  const online = machines.data?.filter((machine) => machine.online) ?? [];
  // "Waiting for a machine" is only truthful when one could eventually claim the turn.
  const queuedHint = !machines.data
    ? t("ui.waitingForAMachine")
    : !online.length
      ? t("ui.noMachineIsOnlineStartOneWithNpmRunDaemon")
      : runtime && !online.some((machine) => machine.runtimes.some((item) => item === runtime))
        ? t("ui.noOnlineMachineSupportsTheRuntimeRuntime", { runtime })
        : t("ui.waitingForAMachine");
  const navigate = useNavigate();
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
              <h1>{t("ws.greeting", { name: agentName })}</h1>
              <p>{t("ws.greetingHelp")}</p>
              <div className="suggestions">
                {[
                  ...[{ icon: Split, label: t("ws.suggestSplit") }, { icon: ListChecks, label: t("ws.suggestProgress") }, { icon: ClipboardCheck, label: t("ws.suggestReview") }].map((item) => ({ ...item, run: () => { setText(item.label); textarea.current?.focus(); } })),
                  { icon: BookOpen, label: t("phaseC.importSkill"), run: () => navigate("/skills/new") },
                ].map(({ icon: Icon, label, run }) => (
                  <button key={label} onClick={run}>
                    <span className="suggestion-icon"><Icon size={14} /></span>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <MessageStream messages={messages.data} agentName={agentName} todoId={todoId} />
        )}
        {currentStatus !== "idle" && (
          <div className="live-status" role="status">
            <span className="pulse-dot" />
            {currentStatus === "queued" ? queuedHint : t("ui.working")}
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
          <MentionInput
            ref={textarea}
            aria-label={t("ui.message")}
            value={text}
            rows={3}
            placeholder={
              disabled ?? placeholder ?? t("ws.askMaster", { name: agentName })
            }
            disabled={!!disabled || !conversationId}
            onValue={setText}
            onKeyDown={keydown}
          />
          <div className="composer-footer">
            <span className="hint">
              {agentName}
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
      </div>
    </div>
  );
}
