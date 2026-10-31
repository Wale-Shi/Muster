import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connectionSchema, type Connection, type TurnConnection } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import type { EventBus } from "../events.js";
import { StateError } from "../orchestrator/state.js";
import type { Vault } from "./vault.js";

export class Connections {
  constructor(readonly db: MusterDb, readonly vault: Vault, readonly events: EventBus) {}
  private values(key: string): Record<string, string> {
    const r = this.db.row("SELECT * FROM connections WHERE id=?", key); if (!r) throw new StateError("Connection not found", 404);
    return JSON.parse(this.vault.decrypt({ ciphertext: String(r.secret_json_ciphertext), iv: String(r.iv), tag: String(r.tag) }, `connection:${key}:${r.identifier}`));
  }
  list(): Connection[] {
    return this.db.rows("SELECT * FROM connections ORDER BY name").map((r) => ({ id: String(r.id), identifier: String(r.identifier), name: String(r.name), catalogId: r.catalog_id as string | null, transport: r.transport as Connection["transport"], url: r.url as string | null, command: r.command as string | null, args: JSON.parse(String(r.args_json)), machineId: r.machine_id as string | null, secretKeys: Object.keys(this.values(String(r.id))), createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  get(key: string): Connection { const c = this.list().find((c) => c.id === key); if (!c) throw new StateError("Connection not found", 404); return c; }
  save(value: unknown, key?: string): Connection {
    const old = key ? this.get(key) : undefined; const input = connectionSchema.parse(old ? { ...old, ...value as object } : value);
    if (old && old.identifier !== input.identifier) throw new StateError("Connection identifier is immutable", 400);
    if (this.db.row("SELECT id FROM connections WHERE identifier=? AND id<>?", input.identifier, key ?? "")) throw new StateError("Connection identifier already exists", 409);
    if (input.machineId && !this.db.row("SELECT id FROM machines WHERE id=?", input.machineId)) throw new StateError("Machine not found", 400);
    const connectionId = key ?? id(); const encrypted = this.vault.encrypt(JSON.stringify(input.secrets ?? (key ? this.values(key) : {})), `connection:${connectionId}:${input.identifier}`);
    this.db.run(`INSERT INTO connections VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,catalog_id=excluded.catalog_id,transport=excluded.transport,url=excluded.url,command=excluded.command,args_json=excluded.args_json,machine_id=excluded.machine_id,secret_json_ciphertext=excluded.secret_json_ciphertext,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at`, connectionId, input.identifier, input.name, input.catalogId ?? null, input.transport, input.transport === "http" ? input.url : null, input.transport === "stdio" ? input.command : null, JSON.stringify(input.args), input.machineId ?? null, encrypted.ciphertext, encrypted.iv, encrypted.tag, now(), now());
    this.changed(); return this.get(connectionId);
  }
  delete(key: string): void {
    this.get(key); this.db.transaction(() => {
      for (const r of this.db.rows("SELECT * FROM agents")) { const ids = this.db.agent(r).connectionIds ?? []; if (ids.includes(key)) this.db.run("UPDATE agents SET connection_ids_json=?,updated_at=? WHERE id=?", JSON.stringify(ids.filter((id) => id !== key)), now(), r.id); }
      this.db.run("DELETE FROM connections WHERE id=?", key);
    }); this.changed(); this.events.emit({ type: "agent.changed", payload: {} });
  }
  grant(agentId: string, connectionId: string, grant: boolean): void {
    this.get(connectionId); const r = this.db.row("SELECT * FROM agents WHERE id=?", agentId); if (!r) throw new StateError("Agent not found", 404);
    const ids = new Set(this.db.agent(r).connectionIds); if (grant) ids.add(connectionId); else ids.delete(connectionId);
    this.db.run("UPDATE agents SET connection_ids_json=?,updated_at=? WHERE id=?", JSON.stringify([...ids]), now(), agentId); this.events.emit({ type: "agent.changed", payload: {} });
  }
  delivery(ids: string[], machineId: string): { connections: TurnConnection[]; omitted: string[] } {
    const connections: TurnConnection[] = []; const omitted: string[] = [];
    for (const c of this.list().filter((c) => ids.includes(c.id))) {
      if (c.transport === "stdio" && c.machineId && c.machineId !== machineId) { omitted.push(c.name); continue; }
      connections.push(c.transport === "http" ? { identifier: c.identifier, transport: "http", url: c.url!, headers: this.values(c.id) } : { identifier: c.identifier, transport: "stdio", command: c.command!, args: c.args, env: this.values(c.id) });
    }
    return { connections, omitted };
  }
  async test(key: string): Promise<{ ok: boolean; toolCount: number; tools: string[]; error: string | null }> {
    const c = this.get(key);
    if (c.transport === "stdio") return { ok: false, toolCount: 0, tools: [], error: "Will be tested by the machine on next run" };
    const client = new Client({ name: "muster-connection-test", version: "1.0.0" });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    const transport = new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers: this.values(key) }, fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }) });
    try {
      await client.connect(transport); let cursor: string | undefined; let toolCount = 0; const tools: string[] = [];
      do { const page = await client.listTools({ cursor }, { signal: controller.signal, timeout: 10000 }); toolCount += page.tools.length; tools.push(...page.tools.map((t) => t.name).slice(0, 50 - tools.length)); cursor = page.nextCursor; } while (cursor);
      return { ok: true, toolCount, tools, error: null };
    } catch { return { ok: false, toolCount: 0, tools: [], error: "Connection test failed. Check the address, credentials and server availability." }; }
    finally { controller.abort(); clearTimeout(timer); await client.close().catch(() => {}); }
  }
  private changed(): void { this.events.emit({ type: "connection.changed", payload: {} }); }
}
