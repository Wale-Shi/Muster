import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

it("replays SSE after Last-Event-ID across a database reopen and preserves full message payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "muster-sse-"));
  const path = join(root, "muster.db");
  const first = createApp({ databasePath: path });
  first.services.orchestrator.addMessage("topic", null, "system", "First", {});
  const cursor = first.services.events.replay("0")[0]!.id!;
  const secondId = first.services.orchestrator.addMessage("topic", null, "user", "Second", {});
  first.services.db.close();
  const reopened = createApp({ databasePath: path });
  try {
    const response = await reopened.app.request("/api/events", { headers: { "last-event-id": cursor } });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader(); let text = "";
    while (!text.includes("data:")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const data = text.split("\n").find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(data.slice(6))).toMatchObject({ type: "message.created", payload: { id: secondId, content: "Second", conversationId: "topic", turnId: null, meta: { revision: 0 } } });
    expect(text).toContain(`id: ${Number(cursor) + 1}\n`); expect(text).not.toContain('"content":"First"');
  } finally { reopened.services.db.close(); rmSync(root, { recursive: true, force: true }); }
});
