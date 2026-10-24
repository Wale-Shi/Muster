import { z } from "zod";
export const connectionIdentifier = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/).refine((s) => s !== "muster");
export const connectionFields = z.object({
  identifier: connectionIdentifier, name: z.string().trim().min(1).max(100), catalogId: z.string().nullable().optional(),
  transport: z.enum(["http", "stdio"]), url: z.string().url().nullable().optional(), command: z.string().trim().min(1).max(1000).nullable().optional(),
  args: z.array(z.string().max(4000)).max(100).default([]), machineId: z.string().uuid().nullable().optional(),
  secrets: z.record(z.string().min(1).max(200), z.string().max(16000)).optional(),
});
export const updateConnectionSchema = connectionFields.partial().extend({ args: connectionFields.shape.args.removeDefault().optional() });
export const connectionSchema = connectionFields.superRefine((c, ctx) => {
  if (c.transport === "http" && (!c.url || !/^https?:\/\//.test(c.url) || c.machineId)) ctx.addIssue({ code: "custom", path: ["url"], message: "HTTP URL required; remote connections cannot be machine pinned" });
  if (c.transport === "stdio" && !c.command) ctx.addIssue({ code: "custom", path: ["command"], message: "Command required" });
});
export type ConnectionInput = z.infer<typeof connectionSchema>;
export interface Connection extends Omit<ConnectionInput, "secrets"> { id: string; secretKeys: string[]; createdAt: string; updatedAt: string }
export interface TurnConnection { identifier: string; transport: "http" | "stdio"; url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> }
