import { Hono } from "hono";
import { todoMessageSchema } from "@muster/shared";
import type { AppServices } from "../services.js";
import { StateError } from "../orchestrator/state.js";
import { body } from "./helpers.js";

export function queueRoutes({ db, events }: AppServices): Hono {
  const app = new Hono();
  app.get("/:id/queued-messages", (c) => c.json({ data: db.rows("SELECT * FROM queued_messages WHERE conversation_id=? AND delivered_at IS NULL ORDER BY rowid", c.req.param("id"))
    .map((row) => ({ id: String(row.id), conversationId: String(row.conversation_id), content: String(row.content), createdAt: String(row.created_at), deliveredAt: null, delivering: row.delivery_turn_id !== null })) }));
  const editable = (conversationId: string, messageId: string) => {
    const row = db.row("SELECT * FROM queued_messages WHERE id=? AND conversation_id=?", messageId, conversationId);
    if (!row) throw new StateError("Queued message not found", 404);
    if (row.delivered_at || row.delivery_turn_id) throw new StateError("Message is already being delivered");
    return row;
  };
  app.patch("/:id/queued-messages/:messageId", async (c) => {
    const input = await body(c, todoMessageSchema);
    const conversationId = c.req.param("id"); const messageId = c.req.param("messageId");
    const row = editable(conversationId, messageId);
    if (row.source_message_id) {
      db.run("UPDATE messages SET content=?, meta_json=json_set(meta_json, '$.revision', COALESCE(json_extract(meta_json, '$.revision'),0)+1) WHERE id=?", input.content, row.source_message_id);
      events.emit({ type: "message.updated", conversationId, payload: {}, message: db.message(db.row("SELECT * FROM messages WHERE id=?", row.source_message_id)!) });
    }
    db.run("UPDATE queued_messages SET content=? WHERE id=?", input.content, messageId);
    events.emit({ type: "message.queue_changed", conversationId, payload: { id: messageId } });
    return c.json({ data: { id: messageId, content: input.content } });
  });
  app.delete("/:id/queued-messages/:messageId", (c) => {
    const conversationId = c.req.param("id"); const messageId = c.req.param("messageId");
    const row = editable(conversationId, messageId);
    db.run("DELETE FROM queued_messages WHERE id=?", messageId);
    if (row.source_message_id) {
      db.run("DELETE FROM messages WHERE id=?", row.source_message_id);
      events.emit({ type: "message.deleted", conversationId, payload: { id: row.source_message_id } });
    }
    events.emit({ type: "message.queue_changed", conversationId, payload: { id: messageId } });
    return c.body(null, 204);
  });
  return app;
}
