import type { ServerEvent } from "@muster/shared";
import type { MusterDb } from "./db/index.js";

type Listener = (event: ServerEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();
  constructor(private db: MusterDb) {}

  emit(event: ServerEvent): void {
    const inserted = this.db.raw.prepare("INSERT INTO server_events(event_json) VALUES (?)").run(JSON.stringify(event));
    const stored = { ...event, id: String(inserted.lastInsertRowid) };
    for (const listener of this.listeners) listener(stored);
  }

  replay(after: string): ServerEvent[] {
    if (!/^\d+$/.test(after)) return [];
    return this.db.rows("SELECT * FROM server_events WHERE id > ? ORDER BY id", after)
      .map((row) => ({ ...JSON.parse(String(row.event_json)) as ServerEvent, id: String(row.id) }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
