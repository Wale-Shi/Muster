import { z } from "zod";
import { RUNTIME_IDS } from "./runtimes.js";

export const idSchema = z.string().min(1);
export const runtimeSchema = z.enum(RUNTIME_IDS);
export const todoPhaseSchema = z.enum(["todo", "queued", "building", "review", "failed", "done", "closed"]);

export const createProjectSchema = z.object({
  description: z.string().max(16000).optional(),
  name: z.string().trim().min(1),
  repoUrl: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).default("main"),
  chiefAgentId: idSchema.nullable().optional(),
});
export const updateProjectSchema = createProjectSchema.partial();

// Unknown keys (from removed permissions) are dropped rather than rejected.
export const permissionsSchema = z.object({ createSkills: z.boolean().default(false), updateSkills: z.boolean().default(false) });
export const createSkillSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(2000), instructions: z.string().trim().min(1).max(100000) });
export const updateSkillSchema = createSkillSchema.omit({ name: true }).partial();
export const githubSkillSchema = z.object({ url: z.string().url() });

export const createAgentSchema = z.object({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1),
  runtime: runtimeSchema,
  model: z.string().trim().min(1),
  reasoning: z.string().trim().nullable().optional(),
  avatar: z.string().trim().nullable().optional(),
  permissions: permissionsSchema.optional(),
  defaultSkillIds: z.array(idSchema).max(200).optional(),
  connectionIds: z.array(idSchema).max(200).optional(),
});
export const updateAgentSchema = createAgentSchema.partial();

export const createTodoSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(1),
  spec: z.string().default(""),
  agentId: idSchema.nullable().optional(),
  createdBy: z.enum(["user", "chief"]).default("user"),
  /** Queue the task right away instead of leaving it in the backlog. */
  start: z.boolean().default(false),
});
export const updateTodoSchema = z.object({
  title: z.string().trim().min(1).optional(),
  spec: z.string().optional(),
  agentId: idSchema.nullable().optional(),
});
export const startTodoSchema = z.object({ agentId: idSchema.optional() });
export const todoMessageSchema = z.object({ content: z.string().trim().min(1) });
export const doneTodoSchema = z.object({ merge: z.boolean().default(true) });
export const rerunTodoSchema = z.object({ strategy: z.enum(["continue", "restart"]) });

export const topicMessageSchema = z.object({ content: z.string().trim().min(1) });

export const enrollMachineSchema = z.object({
  name: z.string().trim().min(1),
  runtimes: z.array(runtimeSchema).min(1),
  concurrency: z.number().int().min(1).max(64).default(6),
});
export const heartbeatSchema = z.object({ running: z.array(idSchema).default([]) });
const runtimeModelSchema = z.object({ id: z.string().min(1).max(200), name: z.string().max(200).optional(), reasoning: z.array(z.string().max(40)).max(12).optional() });
export const machineModelsSchema = z.object({
  models: z.partialRecord(runtimeSchema, z.object({ models: z.array(runtimeModelSchema).max(500), error: z.string().max(500).optional(), checkedAt: z.string() })),
});
export const updateMachineSchema = z.object({ concurrency: z.number().int().min(1).max(64) });
export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.delta"), content: z.string() }),
  z.object({ type: z.literal("message.completed"), content: z.string().optional() }),
  z.object({ type: z.literal("reasoning.delta"), content: z.string() }),
  z.object({ type: z.literal("tool.started"), tool: z.string(), callId: z.string().optional(), input: z.unknown().optional() }),
  z.object({ type: z.literal("tool.completed"), tool: z.string(), callId: z.string().optional(), output: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("plan.updated"), content: z.string() }),
  z.object({ type: z.literal("usage"), tokensIn: z.number().int().nonnegative(), tokensOut: z.number().int().nonnegative() }),
  z.object({ type: z.literal("status"), status: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal("warning"), detail: z.string() }),
]);
export const agentEventsSchema = z.array(agentEventSchema);
export const eventUploadSchema = z.object({ batchId: idSchema, events: agentEventsSchema });
export const claimSchema = z.object({ requestId: idSchema.optional() });
export const inboxAckSchema = z.object({ ids: z.array(idSchema).min(1) });
export const turnCompleteSchema = z.object({
  status: z.enum(["done", "failed", "stopped"]),
  headCommit: z.string().optional(),
  baseCommit: z.string().optional(),
  diff: z.string().optional(),
  usage: z.object({ tokensIn: z.number().int().nonnegative(), tokensOut: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative() }).optional(),
  error: z.string().optional(),
  sessionState: z.record(z.string(), z.unknown()).optional(),
  merge: z.object({ ok: z.boolean(), error: z.string().optional() }).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
