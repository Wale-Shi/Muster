import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useDroppable } from "@dnd-kit/core";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Command,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message, Todo } from "@muster/shared";
import { QueuedMessages } from "./QueuedMessages";
import { api } from "../api/client";
import { useMessages } from "../api/queries";
import { useRealtime } from "../api/realtime";
import { Avatar, ErrorNotice, Loading } from "./ui";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

function ToolGroup({ messages }: { messages: Message[] }) {
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
            ? "Thinking"
            : `${calls.length || messages.length} tool ${calls.length === 1 ? "call" : "calls"}`}
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
                ? "reasoning"
                : "tool"}{" "}
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
            <Markdown>{item.content}</Markdown>
            <span className="system-line" />
          </div>
        ) : (
          <article key={item.id} className={`message ${item.role}`}>
            <div className="message-author">
              <Avatar name={item.role === "user" ? "You" : agentName} small />
              <strong>{item.role === "user" ? "You" : agentName}</strong>
              <time dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleTimeString([], {
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
              Try again
            </button>
          </div>
        ) : !messages.data?.length ? (
          initialSpec ? (
            <article className="message user">
              <div className="message-author">
                <Avatar name="You" small />
                <strong>Task description</strong>
              </div>
              <Markdown>{initialSpec}</Markdown>
            </article>
          ) : (
            <div className="chief-empty">
              <span className="chief-mark">
                <Command size={24} />
              </span>
              <h1>How can I help?</h1>
              <p>Share a goal. I’ll help turn it into progress.</p>
              <div className="suggestions">
                {["Plan my next feature", "What needs my attention?"].map(
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
            {currentStatus === "queued" ? "Waiting for a machine" : "Working…"}
            {currentStatus === "running" && activity?.detail && (
              <span className="dim">{activity.detail}</span>
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
          Latest messages
        </button>
      )}
      <div className="composer-wrap">
        <QueuedMessages conversationId={conversationId} />
        <ErrorNotice error={send.error} />
        <div
          ref={setNodeRef}
          className={`composer ${isOver ? "drag-over" : ""}`}
        >
          {isOver && (
            <div className="drop-hint">Drop to reference this task</div>
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
                    aria-label={`Remove reference #${todo.number}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textarea}
            aria-label="Message"
            value={text}
            rows={3}
            placeholder={
              disabled ?? placeholder ?? "Ask Chief, or drop a task here…"
            }
            disabled={!!disabled || !conversationId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keydown}
          />
          <div className="composer-footer">
            <span className="hint">
              {todoId ? agentName : "Chief"}
              <span className="composer-shortcut"> · ↵ send · ⇧↵ new line</span>
            </span>
            <button
              className="send-button"
              aria-label="Send message"
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
            ? "Guide the agent with feedback and context"
            : "One conversation. A whole team of agents."}
        </div>
      </div>
    </div>
  );
}
