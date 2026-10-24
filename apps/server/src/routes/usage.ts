import type { UsageEntry, UsageReport } from "@muster/shared";
import type { MusterDb } from "../db/index.js";

export function usageReport(db: MusterDb): UsageReport {
  const row = db.row("SELECT COALESCE(sum(tokens_in),0) tokens_in, COALESCE(sum(tokens_out),0) tokens_out, COALESCE(sum(duration_ms),0) duration_ms, count(*) builds FROM builds")!;
  const entries: UsageEntry[] = db.rows("SELECT t.*, b.todo_id, b.branch FROM turns t JOIN builds b ON b.id=t.build_id WHERE t.started_at IS NOT NULL AND t.status NOT IN ('queued','running') ORDER BY t.rowid").map((turn) => {
    const agent = JSON.parse(String(turn.agent_snapshot_json ?? "{}")) as Record<string, unknown>;
    return { turnId: String(turn.id), buildId: String(turn.build_id), todoId: turn.todo_id as string | null,
      topicId: turn.todo_id ? null : String(turn.branch).replace(/^chief:/, ""), agentId: agent.id ? String(agent.id) : null,
      agentName: String(agent.name ?? "Unknown"), runtime: (agent.runtime ?? null) as UsageEntry["runtime"], model: String(agent.model ?? "Unknown"),
      startedAt: String(turn.started_at), tokensIn: Number(turn.tokens_in), tokensOut: Number(turn.tokens_out), durationMs: Number(turn.duration_ms) };
  });
  // Totals and breakdowns both describe completed turns. Active usage is provisional.
  return { tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out), durationMs: Number(row.duration_ms), builds: Number(row.builds),
    turns: Number(db.row("SELECT count(*) count FROM turns")?.count ?? 0), entries };
}
