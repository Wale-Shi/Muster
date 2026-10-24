import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@muster/shared";
import { id, type MusterDb } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";
export const attachmentLimit = 20 * 1024 * 1024;
export class Attachments {
  constructor(private db: MusterDb, private root: string) {}
  list(todoId: string): Attachment[] { return this.db.rows("SELECT * FROM attachments WHERE todo_id=? ORDER BY rowid", todoId).map((r) => ({ id: String(r.id), todoId, name: String(r.name), size: Number(r.size), hash: String(r.hash) })); }
  async add(todoId: string, files: File[]) {
    const todo = this.db.row("SELECT phase FROM todos WHERE id=?", todoId);
    if (!todo) throw new StateError("Todo not found", 404);
    if (todo.phase !== "todo") throw new StateError("Attachments require a backlog task", 409);
    const prepared = await Promise.all(files.map(async (file) => ({ name: file.name.replace(/[\x00-\x1f]/g, "").slice(0, 255), bytes: Buffer.from(await file.arrayBuffer()) })));
    const written: string[] = [];
    try { this.db.transaction(() => {
      const existing = this.list(todoId);
      if (!files.length || files.length + existing.length > 10 || prepared.reduce((n, f) => n + f.bytes.length, existing.reduce((n, f) => n + f.size, 0)) > attachmentLimit) throw new StateError("Attachment limit exceeded (10 files, 20 MB)", 400);
      const dir = join(this.root, todoId); mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const file of prepared) { const fileId = id(); const path = join(dir, fileId); writeFileSync(path, file.bytes, { flag: "wx", mode: 0o600 }); written.push(path); this.db.run("INSERT INTO attachments VALUES (?, ?, ?, ?, ?)", fileId, todoId, file.name, file.bytes.length, createHash("sha256").update(file.bytes).digest("hex")); }
    }); } catch (error) { for (const path of written) rmSync(path, { force: true }); throw error; }
    return this.list(todoId);
  }
  download(fileId: string) {
    const row = this.db.row("SELECT * FROM attachments WHERE id=?", fileId); if (!row) throw new StateError("Attachment not found", 404);
    return { ...this.list(String(row.todo_id)).find((f) => f.id === fileId)!, content: readFileSync(join(this.root, String(row.todo_id), fileId)).toString("base64") };
  }
  delete(todoId: string) { this.db.run("DELETE FROM attachments WHERE todo_id=?", todoId); rmSync(join(this.root, todoId), { recursive: true, force: true }); }
}
