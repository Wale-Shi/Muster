import type { Message, Runtime, TurnKind } from "./types.js";
import type { z } from "zod";
import type { agentEventSchema, turnCompleteSchema, eventUploadSchema } from "./schemas.js";

export interface TurnJob {
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

export const DEFAULT_MODELS: Record<Runtime, string> = { codex: "gpt-6.1-sol", claude: "claude-sonnet-5-5", mock: "mock" };
