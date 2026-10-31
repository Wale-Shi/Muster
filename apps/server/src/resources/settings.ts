import { createHash, randomInt } from "node:crypto";
import { apiKeyInputSchema, workspaceSettingsSchema, type ApiKey, type WorkspaceSettings } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class Settings {
  constructor(private db: MusterDb) {}
  get(): WorkspaceSettings {
    return workspaceSettingsSchema.parse(Object.fromEntries(this.db.rows("SELECT * FROM settings").map((r) => [r.key, JSON.parse(String(r.value))])));
  }
  update(input: unknown): WorkspaceSettings {
    const patch = workspaceSettingsSchema.partial().strict().parse(input);
    this.db.transaction(() => { for (const [key, value] of Object.entries(patch)) this.db.run("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value)); });
    return this.get();
  }
  keys(): ApiKey[] {
    return this.db.rows("SELECT id,name,prefix,scopes_json,created_at,last_used_at,revoked_at FROM api_keys ORDER BY created_at DESC").map((r) => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), scopes: JSON.parse(String(r.scopes_json)), createdAt: String(r.created_at), lastUsedAt: r.last_used_at as string | null, revokedAt: r.revoked_at as string | null }));
  }
  createKey(input: unknown) {
    const { name, scopes } = apiKeyInputSchema.parse(input);
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const key = `mst_${Array.from({ length: 32 }, () => alphabet[randomInt(62)]).join("")}`;
    const keyId = id();
    this.db.run("INSERT INTO api_keys VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)", keyId, name, key.slice(0, 10), hash(key), JSON.stringify(scopes), now());
    return { ...this.keys().find((k) => k.id === keyId)!, key };
  }
  revoke(keyId: string) {
    if (!this.db.row("SELECT id FROM api_keys WHERE id=?", keyId)) throw new StateError("API key not found", 404);
    this.db.run("UPDATE api_keys SET revoked_at=COALESCE(revoked_at, ?) WHERE id=?", now(), keyId);
  }
  authenticate(token: string): ApiKey | null {
    if (!/^mst_[A-Za-z0-9]{32}$/.test(token)) return null;
    const row = this.db.row("SELECT id FROM api_keys WHERE hash=? AND revoked_at IS NULL", hash(token));
    if (!row) return null;
    this.db.run("UPDATE api_keys SET last_used_at=? WHERE id=?", now(), row.id);
    return this.keys().find((k) => k.id === row.id)!;
  }
}
