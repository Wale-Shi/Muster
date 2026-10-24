import { z } from "zod";

export const idSchema = z.string().min(1);
export const runtimeSchema = z.enum(["codex", "claude", "mock"]);
export const todoPhaseSchema = z.enum([
  "todo", "queued", "planning", "confirm", "building", "review", "failed", "done", "closed",
]);

export const createProjectSchema = z.object({
  description: z.string().max(16000).optional(),
  name: z.string().trim().min(1),
  repoUrl: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1).default("main"),
});
export const updateProjectSchema = createProjectSchema.partial();

export const permissionsSchema = z.object({ pushBranch: z.boolean().default(false), secrets: z.boolean().default(false), createSkills: z.boolean().default(false), updateSkills: z.boolean().default(false) }).strict();
export const memorySchema = z.object({ content: z.string().trim().min(1).max(16000) });
export const secretNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine((name) => !/^(PATH|HOME)$|^(MUSTER_|CODEX_|CLAUDE_|ELECTRON_)/.test(name) && !["NODE_OPTIONS", "NODE_ENV"].includes(name), "Reserved environment variable");
export const secretRequestSchema = z.object({ name: secretNameSchema, scope: z.enum(["team", "project"]), projectId: idSchema.optional(), reason: z.string().trim().min(1).max(2000) });
export const putSecretSchema = secretRequestSchema.omit({ reason: true }).extend({ value: z.string().min(1).max(64000), requestId: idSchema.optional() }).refine((v) => v.scope === "project" ? !!v.projectId : !v.projectId, "Project scope requires projectId; team scope forbids it");
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
  planAgentId: idSchema.nullable().optional(),
  mode: z.enum(["plan", "run"]).default("plan"),
  tags: z.array(z.string()).default([]),
  createdBy: z.enum(["user", "chief"]).default("user"),
  topicId: idSchema.nullable().optional(),
});
export const updateTodoSchema = z.object({
  title: z.string().trim().min(1).optional(),
  spec: z.string().optional(),
  agentId: idSchema.nullable().optional(),
  planAgentId: idSchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
});
export const startTodoSchema = z.object({ mode: z.enum(["plan", "run"]), agentId: idSchema.optional() });
export const todoMessageSchema = z.object({ content: z.string().trim().min(1) });
export const doneTodoSchema = z.object({ merge: z.boolean().default(true) });
export const rerunTodoSchema = z.object({ strategy: z.enum(["continue", "restart"]) });

export const createTopicSchema = z.object({ title: z.string().trim().min(1) });
export const updateTopicSchema = createTopicSchema.partial();
export const topicMessageSchema = z.object({ content: z.string().trim().min(1) });

export const enrollMachineSchema = z.object({
  name: z.string().trim().min(1),
  runtimes: z.array(runtimeSchema).min(1),
  concurrency: z.number().int().min(1).max(64).default(6),
});
export const heartbeatSchema = z.object({ running: z.array(idSchema).default([]) });
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
  plan: z.string().optional(),
  usage: z.object({ tokensIn: z.number().int().nonnegative(), tokensOut: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative() }).optional(),
  error: z.string().optional(),
  sessionState: z.record(z.string(), z.unknown()).optional(),
  merge: z.object({ ok: z.boolean(), error: z.string().optional() }).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type CreateTodoInput = z.infer<typeof createTodoSchema>;
