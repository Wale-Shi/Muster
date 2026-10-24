import type { Runtime, TurnKind } from "./types.js";

export interface TurnJob {
  turnId: string;
  buildId: string;
  todoId: string | null;
  kind: TurnKind;
  project: { id: string; repoUrl: string; baseBranch: string } | null;
  branch: string | null;
  agent: {
    runtime: Runtime;
    model: string;
    reasoning: string | null;
    role: string;
  };
  prompt: string;
  systemInstructions: string;
  sessionState: Record<string, unknown> | null;
  readOnly: boolean;
  mcp: { url: string; token: string };
}

export type AgentEvent =
  | { type: "message.delta"; content: string }
  | { type: "message.completed"; content?: string }
  | { type: "reasoning.delta"; content: string }
  | { type: "tool.started"; tool: string; callId?: string; input?: unknown }
  | { type: "tool.completed"; tool: string; callId?: string; output?: unknown; error?: string }
  | { type: "plan.updated"; content: string }
  | { type: "usage"; tokensIn: number; tokensOut: number }
  | { type: "status"; status: string; detail?: string };

export interface TurnCompletePayload {
  status: "done" | "failed" | "stopped";
  headCommit?: string;
  diff?: string;
  plan?: string;
  usage?: { tokensIn: number; tokensOut: number; durationMs: number };
  error?: string;
  sessionState?: Record<string, unknown>;
  merge?: { ok: boolean; error?: string };
}

export interface ServerEvent {
  type: string;
  todoId?: string;
  conversationId?: string;
  payload: unknown;
}
