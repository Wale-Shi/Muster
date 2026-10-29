import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(() => { while (apps.length) apps.pop()?.services.db.close(); });
const setup = () => {
  const created = createApp({ claimWaitMs: 0, autoFollowUp: false });
  apps.push(created);
  return created;
};
const insertOld = (db: ReturnType<typeof createApp>["services"]["db"], count: number, ageMs = 2 * 86_400_000) => {
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  for (let index = 0; index < count; index += 1) db.run("INSERT INTO server_events(event_json, created_at) VALUES (?, ?)", JSON.stringify({ type: "test", payload: {} }), createdAt);
};

describe("server event retention", () => {
  it("drops events older than a day but always keeps the newest 5,000", () => {
    const { services } = setup(); const { events, db } = services;
    insertOld(db, 5_100);
    events.prune();
    expect(Number(db.row("SELECT count(*) AS count FROM server_events")?.count)).toBe(5_000);
    expect(Number(db.row("SELECT min(id) AS id FROM server_events")?.id)).toBe(101);
  });

  it("prunes while emitting and asks a client with a pruned cursor to resync", async () => {
    const { app, services } = setup(); const { events, db } = services;
    insertOld(db, 5_000);
    for (let index = 0; index < 500; index += 1) events.emit({ type: "test", payload: { index } });
    expect(Number(db.row("SELECT count(*) AS count FROM server_events")?.count)).toBe(5_000);
    expect(Number(db.row("SELECT min(id) AS id FROM server_events")?.id)).toBe(501);
    // A cursor at 500 still sees every retained event; 499 missed pruned history.
    expect(events.replay("499")).toEqual([{ id: "500", type: "sync.reset", payload: {} }]);
    expect(events.replay("500")).toHaveLength(5_000);
    expect(events.replay("")).toEqual([]);
    // The SSE endpoint forwards the reset to the reconnecting client.
    const response = await app.request("/api/events", { headers: { "last-event-id": "499" } });
    const reader = response.body!.getReader(); let text = "";
    while (!text.includes("data:")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('id: 500');
    expect(text).toContain('"type":"sync.reset"');
  });
});
