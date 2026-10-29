import type { Message, Runtime, TurnKind } from "./types.js";
import type { z } from "zod";
import { RUNTIMES } from "./runtimes.js";
import type { agentEventSchema, turnCompleteSchema, eventUploadSchema } from "./schemas.js";

export interface TurnJob {
  task?: { number: number; title: string; summary: string; url: string };
  attachments?: import("./settings.js").Attachment[];
  connections?: import("./connections.js").TurnConnection[];
  skills?: { slug: string; name: string; description: string; version: string }[];
  env?: Record<string, string>;
  pushBranch?: boolean;
  turnId: string;
  buildId: string;
  todoId: string | null;
  topicId: string | null;
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

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type TurnCompletePayload = z.infer<typeof turnCompleteSchema>;
export type EventUpload = z.infer<typeof eventUploadSchema>;

export const SYNC_RESET_EVENT = "sync.reset" as const;

export interface ServerEvent {
  id?: string;
  turnId?: string;
  messageId?: string;
  message?: Message;
  type: string;
  todoId?: string;
  conversationId?: string;
  payload: unknown;
}

/** Sent to one reconnecting client when its cursor predates the retained event log. */
export interface SyncResetEvent extends ServerEvent { type: typeof SYNC_RESET_EVENT }

export const DEFAULT_MODELS = Object.fromEntries(RUNTIMES.map((runtime) => [runtime.id, runtime.defaultModel])) as Record<Runtime, string>;
// Chief coordinates rather than codes, so it defaults to the stronger planning model.
export const CHIEF_MODEL = { runtime: "codex", model: "gpt-6-astra", reasoning: "medium" } as const;
