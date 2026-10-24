import { z } from "zod";

export const notificationPreferencesSchema = z.object({ confirm: z.boolean().default(true), review: z.boolean().default(true), failed: z.boolean().default(true), done: z.boolean().default(true), dockBadge: z.boolean().default(true) }).strict();
export const workspaceSettingsSchema = z.object({ workspaceName: z.string().trim().min(1).max(100).default("Muster"), language: z.enum(["en", "zh-CN"]).default("en"), appearance: z.enum(["light", "dark", "system"]).default("system"), notifications: notificationPreferencesSchema.default({ confirm: true, review: true, failed: true, done: true, dockBadge: true }) }).strict();
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const apiKeyInputSchema = z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(["chief", "read"])).min(1).max(2) }).strict();
export interface ApiKey { id: string; name: string; prefix: string; scopes: ("chief" | "read")[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface Attachment { id: string; todoId: string; name: string; size: number; hash: string }
