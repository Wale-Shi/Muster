export type Id = string;
export type Timestamp = string;

export type { Runtime } from "./runtimes.js";
import type { Runtime } from "./runtimes.js";
export type TodoPhase =
  | "todo"
  | "queued"
  | "planning"
  | "confirm"
  | "building"
  | "review"
  | "failed"
  | "done"
  | "closed";
export type TurnKind = "plan" | "build" | "revise" | "merge" | "chief";
export type TurnStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type BuildStatus = "active" | "done" | "failed" | "closed";
export type MessageRole = "user" | "agent" | "system" | "tool";
export type DocumentKind = "plan" | "changes";

export interface Project {
  description?: string;
  id: Id;
  name: string;
  repoUrl: string;
  baseBranch: string;
  createdAt: Timestamp;
}

export interface AgentPermissions { pushBranch: boolean; secrets: boolean; createSkills: boolean; updateSkills: boolean }
export interface AgentMemory { id: string; agentId: string; content: string; source: "user" | "agent"; createdAt: string; updatedAt: string }
export interface Skill { id: string; slug: string; name: string; description: string; source: Record<string, unknown>; createdAt: string; updatedAt: string; version: string }
export interface SkillFile { path: string; content: string }
export interface Secret { id: string; scope: "team" | "project"; projectId: string | null; name: string; updatedAt: string }

export interface Agent {
  id: Id;
  name: string;
  role: string;
  runtime: Runtime;
  model: string;
  reasoning: string | null;
  avatar: string | null;
  isChief: boolean;
  permissions?: AgentPermissions;
  defaultSkillIds?: string[];
  connectionIds?: string[];
  updatedAt?: Timestamp;
  createdAt: Timestamp;
}

/** A model a runtime CLI offers, as reported by a machine. */
export interface RuntimeModel { id: string; name?: string | undefined; reasoning?: string[] | undefined }
/** What one machine found when it asked a runtime CLI for its models. */
export interface RuntimeModels { models: RuntimeModel[]; error?: string | undefined; checkedAt: Timestamp }
export type MachineModels = Partial<Record<Runtime, RuntimeModels>>;

export interface Machine {
  id: Id;
  name: string;
  concurrency: number;
  runtimes: Runtime[];
  models?: MachineModels;
  lastSeenAt: Timestamp | null;
  createdAt: Timestamp;
  online?: boolean;
  running?: number;
}

export interface Todo {
  id: Id;
  number: number;
  projectId: Id;
  title: string;
  spec: string;
  phase: TodoPhase;
  agentId: Id | null;
  planAgentId: Id | null;
  mode: "plan" | "run";
  tags: string[];
  createdBy: "user" | "chief";
  topicId: Id | null;
  previousGate: "confirm" | "review" | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  doneAt: Timestamp | null;
}

export interface Build {
  id: Id;
  todoId: Id | null;
  branch: string;
  machineId: Id | null;
  status: BuildStatus;
  baseCommit: string | null;
  headCommit: string | null;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  createdAt: Timestamp;
}

export interface Turn {
  id: Id;
  buildId: Id;
  kind: TurnKind;
  status: TurnStatus;
  machineId: Id | null;
  prompt: string;
  startedAt: Timestamp | null;
  endedAt: Timestamp | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
}

export interface Message {
  id: Id;
  conversationId: Id;
  turnId: Id | null;
  role: MessageRole;
  content: string;
  meta: Record<string, unknown>;
  createdAt: Timestamp;
}

export interface Document {
  id: Id;
  buildId: Id;
  kind: DocumentKind;
  version: number;
  content: string;
  createdAt: Timestamp;
}

export interface QueuedMessage {
  id: Id;
  conversationId: Id;
  content: string;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
  delivering: boolean;
}

export interface Topic {
  id: Id;
  title: string;
  runtimeSession: Record<string, unknown> | null;
  activity: "idle" | "queued" | "running";
  activeTurnId: Id | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UsageSummary {
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  builds: number;
  turns: number;
}

export interface UsageEntry {
  turnId: Id;
  buildId: Id;
  todoId: Id | null;
  topicId: Id | null;
  agentId: Id | null;
  agentName: string;
  runtime: Runtime | null;
  model: string;
  startedAt: Timestamp;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}
export interface UsageReport extends UsageSummary { entries: UsageEntry[] }
export type TodoDetail = Todo & { builds: (Build & { turns: Turn[]; documents: Document[] })[] };
