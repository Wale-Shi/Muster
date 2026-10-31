import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SYNC_RESET_EVENT, type Message, type ServerEvent } from "@muster/shared";

type Activity = {
  status: "queued" | "running" | "idle";
  unread: boolean;
  detail?: string;
  warning?: { detail: string; turnId: string | undefined } | undefined;
};
/** The latest thing a task's agent did, for watching work from the board. */
export type TaskLive = { text: string; tool: boolean; at: number };
const idle: Activity = { status: "idle", unread: false };
const RealtimeContext = createContext<{
  connected: boolean;
  activity: Record<string, Activity>;
  live: Record<string, TaskLive>;
  markRead: (id: string) => void;
  dismissWarning: (id: string) => void;
}>({ connected: false, activity: {}, live: {}, markRead: () => {}, dismissWarning: () => {} });
export const useRealtime = () => useContext(RealtimeContext);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// One line of the latest agent output or tool call, or null for other events.
export function liveLine(event: ServerEvent): Pick<TaskLive, "text" | "tool"> | null {
  const payload = record(event.payload);
  if (event.type === "tool.started" && typeof payload.tool === "string") return { text: payload.tool, tool: true };
  if ((event.type === "message.delta" || event.type === "message.completed") && event.message?.content) {
    const line = event.message.content.trim().split("\n").filter(Boolean).at(-1)?.trim();
    return line ? { text: line.slice(-160), tool: false } : null;
  }
  return null;
}

// Each update carries an authoritative message with an increasing revision.
// Replayed deltas cannot duplicate text or overwrite a newer REST snapshot.
export function applyMessageEvent(messages: Message[] | undefined, event: ServerEvent): Message[] | undefined {
  if (!messages || !event.conversationId) return messages;
  if (event.type === "message.deleted") return messages.filter((message) => message.id !== record(event.payload).id);
  const incoming = event.message ?? (event.type === "message.created" ? event.payload as Message : undefined);
  if (!incoming || typeof incoming.id !== "string") return messages;
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...messages, incoming];
  if (Number(messages[index]!.meta.revision ?? 0) >= Number(incoming.meta.revision ?? 0)) return messages;
  return messages.map((message, i) => i === index ? incoming : message);
}

export function mergeMessageSnapshot(
  snapshot: Message[],
  buffered: Message[] = [],
): Message[] {
  const merged = [...snapshot];
  for (const live of buffered) {
    const index = merged.findIndex((message) => message.id === live.id);
    if (index < 0) {
      merged.push(live);
      continue;
    }
    const stored = merged[index]!;
    if (Number(live.meta.revision ?? 0) > Number(stored.meta.revision ?? 0)) merged[index] = live;
  }
  return merged;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<Record<string, Activity>>({});
  const [live, setLive] = useState<Record<string, TaskLive>>({});
  const dismissWarning = useCallback((id: string) => {
    setActivity((prior) => prior[id]?.warning ? { ...prior, [id]: { ...prior[id], warning: undefined } } : prior);
  }, []);
  const markRead = useCallback(
    (id: string) =>
      setActivity((prior) =>
        prior[id]?.unread
          ? { ...prior, [id]: { ...prior[id], unread: false } }
          : prior,
      ),
    [],
  );
  useEffect(() => {
    const source = new EventSource("/api/events");
    const turns = new Map<string, Set<string>>();
    source.onopen = () => {
      setConnected(true);
      void client.invalidateQueries(); // Recover missed events after reconnect.
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (raw) => {
      let event: ServerEvent;
      try {
        const parsed: unknown = JSON.parse(raw.data as string);
        const value = record(parsed);
        if (typeof value.type !== "string") return;
        event = value as unknown as ServerEvent;
      } catch {
        return;
      }
      const { type, conversationId, todoId } = event;
      const payload = record(event.payload);
      // The server pruned past the client's cursor; every cached snapshot may be stale.
      if (type === SYNC_RESET_EVENT) { void client.invalidateQueries(); return; }
      if (type.startsWith("connection.")) void client.invalidateQueries({ queryKey: ["connections"] });
      const line = todoId ? liveLine(event) : null;
      if (todoId && line) setLive((prior) => ({ ...prior, [todoId]: { ...line, at: Date.now() } }));
      if (conversationId) {
        client.setQueryData<Message[]>(
          ["stream-buffer", conversationId],
          (prior) => applyMessageEvent(prior ?? [], event),
        );
        client.setQueryData<Message[]>(["messages", conversationId], (prior) =>
          applyMessageEvent(prior, event),
        );
        if (type.startsWith("turn.") && typeof payload.turnId === "string") {
          const active = turns.get(conversationId) ?? new Set<string>();
          if (type === "turn.completed") active.delete(payload.turnId);
          else active.add(payload.turnId);
          turns.set(conversationId, active);
        }
        setActivity((prior) => {
          const current = prior[conversationId] ?? idle;
          const output = ["message.delta", "reasoning.delta"].includes(type)
            ? typeof payload.content === "string" && payload.content.length > 0
            : ["message.completed", "tool.started", "tool.completed", "plan.updated"].includes(type);
          const warningTurn = current.warning?.turnId;
          const clearsWarning = (output && (!warningTurn || warningTurn === event.turnId)) ||
            (type === "turn.completed" && (!warningTurn || warningTurn === payload.turnId));
          const status =
            type === "turn.queued"
              ? "queued"
              : type === "turn.started"
                ? "running"
                : type === "turn.completed" && !turns.get(conversationId)?.size
                  ? "idle"
                  : current.status;
          return {
            ...prior,
            [conversationId]: {
              ...current,
              status,
              warning: type === "warning" && typeof payload.detail === "string"
                ? { detail: payload.detail, turnId: event.turnId }
                : clearsWarning ? undefined : current.warning,
              unread:
                current.unread ||
                (type === "message.created" && payload.role !== "user"),
              ...(type === "status" && typeof payload.detail === "string"
                ? { detail: payload.detail }
                : output || type === "turn.started" || type === "turn.completed" ? { detail: "" }
                : {}),
            },
          };
        });
        if (type === "turn.completed" || type === "message.completed")
          void client.invalidateQueries({
            queryKey: ["messages", conversationId],
          });
      }
      const entityKey = type.startsWith("todo.")
        ? "todos"
        : type.startsWith("project.")
          ? "projects"
          : type.startsWith("agent.")
            ? "agents"
            : type.startsWith("machine.")
              ? "machines"
              : type.startsWith("topic.")
                ? "topics"
                : null;
      if (/^(agent|skill)\./.test(type)) for (const key of ["agent", "agents", "skill", "skills"]) void client.invalidateQueries({ queryKey: [key] });
      if (entityKey) void client.invalidateQueries({ queryKey: [entityKey] });
      if (todoId && (type.startsWith("todo.") || type.startsWith("turn."))) {
        void client.invalidateQueries({ queryKey: ["todo", todoId] });
        if (type.startsWith("turn."))
          void client.invalidateQueries({ queryKey: ["todos"] });
      }
      if (type === "document.created") {
        void client.invalidateQueries({ queryKey: ["documents"] });
        void client.invalidateQueries({ queryKey: ["todo"] });
      }
      if (conversationId && ["message.queued", "message.delivered", "message.queue_changed", "turn.completed"].includes(type)) {
        void client.invalidateQueries({ queryKey: ["queued-messages", conversationId] });
      }
      if (type.startsWith("turn.")) void client.invalidateQueries({ queryKey: ["topics"] });
      if (type === "turn.completed") void client.invalidateQueries({ queryKey: ["machines"] });
    };
    return () => source.close();
  }, [client]);
  return (
    <RealtimeContext value={{ connected, activity, live, markRead, dismissWarning }}>
      {children}
    </RealtimeContext>
  );
}
