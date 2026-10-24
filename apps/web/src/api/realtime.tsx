import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Message, ServerEvent } from "@muster/shared";

type Activity = {
  status: "queued" | "running" | "idle";
  unread: boolean;
  queued: string[];
  detail?: string;
};
const idle: Activity = { status: "idle", unread: false, queued: [] };
const RealtimeContext = createContext<{
  connected: boolean;
  activity: Record<string, Activity>;
  markRead: (id: string) => void;
}>({ connected: false, activity: {}, markRead: () => {} });
export const useRealtime = () => useContext(RealtimeContext);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

// M1 sends partial message.created payloads. Deltas update the cache in place;
// turn boundaries reconcile the complete, authoritative history over REST.
export function applyMessageEvent(
  messages: Message[] | undefined,
  event: ServerEvent,
): Message[] | undefined {
  if (!messages || !event.conversationId) return messages;
  const payload = record(event.payload);
  if (
    event.type === "message.created" &&
    typeof payload.id === "string" &&
    typeof payload.content === "string" &&
    ["user", "agent", "system", "tool"].includes(String(payload.role))
  ) {
    if (messages.some((message) => message.id === payload.id)) return messages;
    return [
      ...messages,
      {
        id: payload.id,
        conversationId: event.conversationId,
        turnId: null,
        role: payload.role as Message["role"],
        content: payload.content,
        meta: record(payload.meta),
        createdAt: new Date().toISOString(),
      },
    ];
  }
  if (event.type !== "message.delta" && event.type !== "message.completed")
    return messages;
  const index = messages.findLastIndex(
    (message) => message.role === "agent" && message.meta.streaming === true,
  );
  if (index < 0) return messages;
  return messages.map((message, i) =>
    i !== index
      ? message
      : {
          ...message,
          content:
            event.type === "message.delta"
              ? message.content + String(payload.content ?? "")
              : typeof payload.content === "string"
                ? payload.content
                : message.content,
          meta: { ...message.meta, streaming: event.type === "message.delta" },
        },
  );
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
    // REST may have captured a prefix while newer deltas were in flight.
    // A completed REST message is always authoritative.
    if (
      stored.meta.streaming === true &&
      (live.meta.streaming === false || live.content.startsWith(stored.content))
    ) {
      merged[index] = { ...stored, content: live.content, meta: live.meta };
    }
  }
  return merged;
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<Record<string, Activity>>({});
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
              unread:
                current.unread ||
                (type === "message.created" && payload.role !== "user"),
              queued:
                type === "message.queued" && typeof payload.content === "string"
                  ? [...current.queued, payload.content]
                  : type === "turn.completed"
                    ? []
                    : current.queued,
              ...(type === "status" && typeof payload.detail === "string"
                ? { detail: payload.detail }
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
      if (type === "turn.completed") {
        void client.invalidateQueries({ queryKey: ["usage"] });
        void client.invalidateQueries({ queryKey: ["usage-details"] });
        void client.invalidateQueries({ queryKey: ["machines"] });
      }
    };
    return () => source.close();
  }, [client]);
  return (
    <RealtimeContext value={{ connected, activity, markRead }}>
      {children}
    </RealtimeContext>
  );
}
