import type { AgentMemory } from "@muster/shared";
import { memorySchema } from "@muster/shared";
import { id, now, type MusterDb } from "../db/index.js";
import { StateError } from "../orchestrator/state.js";

export class Memories {
  constructor(readonly db: MusterDb) {}
  list(agentId: string): AgentMemory[] {
    if (!this.db.row("SELECT id FROM agents WHERE id=?", agentId)) throw new StateError("Agent not found", 404);
    return this.db.rows("SELECT * FROM agent_memories WHERE agent_id=? ORDER BY created_at DESC, rowid DESC", agentId).map((r) => ({ id: String(r.id), agentId, content: String(r.content), source: r.source as AgentMemory["source"], createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  create(agentId: string, content: string, source: AgentMemory["source"]): AgentMemory {
    this.list(agentId); const input = memorySchema.parse({ content }); const memoryId = id(); const timestamp = now();
    this.db.run("INSERT INTO agent_memories VALUES (?,?,?,?,?,?)", memoryId, agentId, input.content, source, timestamp, timestamp);
    return this.list(agentId).find((m) => m.id === memoryId)!;
  }
  update(agentId: string, memoryId: string, content: string): AgentMemory {
    if (!this.list(agentId).some((m) => m.id === memoryId)) throw new StateError("Memory not found", 404);
    this.db.run("UPDATE agent_memories SET content=?,updated_at=? WHERE id=? AND agent_id=?", memorySchema.parse({ content }).content, now(), memoryId, agentId);
    return this.list(agentId).find((m) => m.id === memoryId)!;
  }
  delete(agentId: string, memoryId: string): void {
    if (!this.list(agentId).some((m) => m.id === memoryId)) throw new StateError("Memory not found", 404);
    this.db.run("DELETE FROM agent_memories WHERE id=? AND agent_id=?", memoryId, agentId);
  }
  instructions(agentId: string): string {
    const content = this.list(agentId).map((m) => `- ${m.content}`).join("\n");
    return content ? `\n\n## Memory\n${content.length > 3900 ? content.slice(0, 3900) + "\n[Older memory truncated]" : content}` : "";
  }
}
