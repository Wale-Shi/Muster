import { describe, expect, it } from "vitest";
import type { Message, ServerEvent } from "@muster/shared";
import { applyMessageEvent, liveLine, mergeMessageSnapshot } from "./realtime";

const message = (id: string, content: string, revision: number, streaming = true): Message => ({ id, conversationId: "conversation", turnId: `turn-${id}`, role: "agent", content, meta: { streaming, revision }, createdAt: "2026-10-24T00:00:00Z" });
const event = (msg: Message): ServerEvent => ({ id: "1", type: "message.delta", conversationId: msg.conversationId, turnId: msg.turnId!, messageId: msg.id, message: msg, payload: { type: "message.delta", content: "unused delta" } });
describe("streaming message cache", () => {
  it("uses stable IDs to separate turns and applies replayed deltas once", () => {
    const one = message("one", "Hello ", 1); const two = message("two", "Other turn", 1);
    let messages = applyMessageEvent([one, two], event(message("one", "Hello world", 2)));
    messages = applyMessageEvent(messages, event(message("one", "Hello world", 2)));
    expect(messages?.map((msg) => msg.content)).toEqual(["Hello world", "Other turn"]);
    messages = applyMessageEvent(messages, event(one));
    expect(messages?.[0]?.content).toBe("Hello world");
  });
  it("persists message identity, metadata, and timestamps from creation and completion", () => {
    const created = message("new", "", 0);
    let messages = applyMessageEvent([], { type: "message.created", conversationId: "conversation", payload: created });
    expect(messages).toEqual([created]);
    const completed = message("new", "Complete", 3, false);
    messages = applyMessageEvent(messages, { ...event(completed), type: "message.completed" });
    expect(messages).toEqual([completed]);
    expect(applyMessageEvent(undefined, event(created))).toBeUndefined();
  });
  it("merges fetch races by revision without replaying prefixes into a REST snapshot", () => {
    const old = message("one", "Hello", 1); const live = message("one", "Hello world", 2);
    expect(mergeMessageSnapshot([old], [live])).toEqual([live]);
    expect(mergeMessageSnapshot([], [live])).toEqual([live]);
    const final = message("one", "Final", 3, false);
    expect(mergeMessageSnapshot([final], [live])).toEqual([final]);
    expect(applyMessageEvent([final], event(old))).toEqual([final]);
  });
});

describe("live task activity", () => {
  it("shows the latest output line or tool call and ignores other events", () => {
    expect(liveLine(event(message("one", "Reading files\n\nEditing src/app.ts  ", 2)))).toEqual({ text: "Editing src/app.ts", tool: false });
    expect(liveLine({ type: "tool.started", todoId: "task", payload: { tool: "write_file" } })).toEqual({ text: "write_file", tool: true });
    expect(liveLine({ type: "tool.completed", todoId: "task", payload: { tool: "write_file" } })).toBeNull();
    expect(liveLine(event(message("one", "   ", 3)))).toBeNull();
  });
});
