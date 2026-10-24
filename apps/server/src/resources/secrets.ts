import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { putSecretSchema, type Secret } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";

export class Secrets {
  constructor(readonly db: MusterDb, readonly directory: string) {}
  private key(): Buffer {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); const path = join(this.directory, "secret.key");
    try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const key = readFileSync(path); if (key.length !== 32) throw new Error("Invalid secret key"); return key;
  }
  encrypt(value: string, binding: string): { ciphertext: string; iv: string; tag: string } {
    const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(binding));
    return { ciphertext: Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }
  decrypt(value: { ciphertext: string; iv: string; tag: string }, binding: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(binding)); decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
  list(projectId?: string): Secret[] {
    return this.db.rows(`SELECT id,scope,project_id,name,updated_at FROM secrets ${projectId ? "WHERE scope='team' OR project_id=?" : ""} ORDER BY scope,name`, ...(projectId ? [projectId] : [])).map((r) => ({ id: String(r.id), scope: r.scope as Secret["scope"], projectId: r.project_id as string | null, name: String(r.name), updatedAt: String(r.updated_at) }));
  }
  put(value: unknown): Secret {
    const input = putSecretSchema.parse(value);
    if (input.projectId && !this.db.row("SELECT id FROM projects WHERE id=?", input.projectId)) throw new StateError("Project not found", 404);
    const previous = this.db.row("SELECT id FROM secrets WHERE scope=? AND project_id IS ? AND name=?", input.scope, input.projectId ?? null, input.name);
    const secretId = String(previous?.id ?? id()); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(`${input.scope}:${input.projectId ?? ""}:${input.name}`));
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]).toString("base64");
    this.db.run("INSERT INTO secrets VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,tag=excluded.tag,updated_at=excluded.updated_at", secretId, input.scope, input.projectId ?? null, input.name, ciphertext, iv.toString("base64"), cipher.getAuthTag().toString("base64"), now(), now());
    return this.list().find((s) => s.id === secretId)!;
  }
  delete(secretId: string): void { if (!this.db.row("SELECT id FROM secrets WHERE id=?", secretId)) throw new StateError("Secret not found", 404); this.db.run("DELETE FROM secrets WHERE id=?", secretId); }
  env(projectId: string | null): Record<string, string> {
    const env: Record<string, string> = {};
    for (const r of this.db.rows("SELECT * FROM secrets WHERE scope='team' OR project_id=? ORDER BY CASE scope WHEN 'team' THEN 0 ELSE 1 END", projectId)) {
      const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(String(r.iv), "base64"));
      decipher.setAAD(Buffer.from(`${r.scope}:${r.project_id ?? ""}:${r.name}`)); decipher.setAuthTag(Buffer.from(String(r.tag), "base64"));
      env[String(r.name)] = Buffer.concat([decipher.update(Buffer.from(String(r.ciphertext), "base64")), decipher.final()]).toString("utf8");
    }
    return env;
  }
}
