import { SYNC_RESET_EVENT } from "@muster/shared";
import type { ServerEvent } from "@muster/shared";
import type { MusterDb } from "./db/index.js";
import { now } from "./db/index.js";

type Listener = (event: ServerEvent) => void;

// Streaming rewrites one message row on every delta but appends a new event each time,
// so the log needs a ceiling that stays small enough for SSE replay to remain cheap.
const KEEP_EVENTS = 5_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 500;

export class EventBus {
  private readonly listeners = new Set<Listener>();
  private inserts = 0;
  constructor(private db: MusterDb) {}

  emit(event: ServerEvent): void {
    const inserted = this.db.raw.prepare("INSERT INTO server_events(event_json, created_at) VALUES (?, ?)").run(JSON.stringify(event), now());
    const stored = { ...event, id: String(inserted.lastInsertRowid) };
    if (++this.inserts % PRUNE_EVERY === 0) this.prune();
    for (const listener of this.listeners) listener(stored);
  }

  /** Delete expired events, always keeping the newest window so live clients stay replayable. */
  prune(): void {
    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    this.db.run("DELETE FROM server_events WHERE created_at < ? AND id NOT IN (SELECT id FROM server_events ORDER BY id DESC LIMIT ?)", cutoff, KEEP_EVENTS);
  }

  replay(after: string): ServerEvent[] {
    if (!/^\d+$/.test(after)) return [];
    const oldest = this.db.row("SELECT min(id) AS id FROM server_events")?.id;
    if (oldest !== null && oldest !== undefined && Number(after) < Number(oldest) - 1) {
      // The cursor points into pruned history: ask the client to refetch instead of
      // silently continuing from an incomplete log.
      return [{ id: String(Number(oldest) - 1), type: SYNC_RESET_EVENT, payload: {} }];
    }
    return this.db.rows("SELECT * FROM server_events WHERE id > ? ORDER BY id", after)
      .map((row) => ({ ...JSON.parse(String(row.event_json)) as ServerEvent, id: String(row.id) }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
