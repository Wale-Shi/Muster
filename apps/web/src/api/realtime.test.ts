import { describe, expect, it } from "vitest";
import type { Message, ServerEvent } from "@muster/shared";
import { applyMessageEvent, mergeMessageSnapshot } from "./realtime";

const event = (type: string, payload: unknown): ServerEvent => ({
  type,
  conversationId: "conversation",
  payload,
});
describe("streaming message cache", () => {
  it("appends deltas once without changing history or duplicating the created message", () => {
    const history: Message = {
      id: "user",
      turnId: null,
      conversationId: "conversation",
      role: "user",
      content: "Hello",
      meta: {},
      createdAt: "2026-10-24T00:00:00Z",
    };
    const created = event("message.created", {
      id: "agent",
      role: "agent",
      content: "",
      meta: { streaming: true },
    });
    let messages = applyMessageEvent([history], created);
    messages = applyMessageEvent(messages, created);
    messages = applyMessageEvent(
      messages,
      event("message.delta", { content: "Hello " }),
    );
    messages = applyMessageEvent(
      messages,
      event("message.delta", { content: "world" }),
    );
    expect(messages).toHaveLength(2);
    expect(messages?.[0]).toBe(history);
    expect(messages?.[1]?.content).toBe("Hello world");
    messages = applyMessageEvent(messages, event("message.completed", {}));
    expect(messages?.[1]?.meta.streaming).toBe(false);
    expect(messages?.[1]?.content).toBe("Hello world");
  });
  it("reconciles an authoritative completed message and tolerates uninitialized caches", () => {
    expect(
      applyMessageEvent(
        undefined,
        event("message.delta", { content: "hello" }),
      ),
    ).toBeUndefined();
    const messages: Message[] = [
      {
        id: "agent",
        turnId: null,
        conversationId: "conversation",
        role: "agent",
        content: "partial",
        meta: { streaming: true },
        createdAt: "",
      },
    ];
    expect(
      applyMessageEvent(
        messages,
        event("message.completed", { content: "complete" }),
      )?.[0]?.content,
    ).toBe("complete");
  });
  it("retains deltas arriving during a history fetch and trusts completed snapshots", () => {
    const base: Message = {
      id: "agent",
      turnId: "turn",
      conversationId: "conversation",
      role: "agent",
      content: "Hello",
      meta: { streaming: true },
      createdAt: "",
    };
    const live = { ...base, content: "Hello world" };
    expect(mergeMessageSnapshot([base], [live])[0]?.content).toBe(
      "Hello world",
    );
    expect(mergeMessageSnapshot([], [live])).toEqual([live]);
    const complete = {
      ...base,
      content: "Final result",
      meta: { streaming: false },
    };
    expect(mergeMessageSnapshot([complete], [live])).toEqual([complete]);
  });
});
