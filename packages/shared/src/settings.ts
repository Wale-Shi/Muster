import { z } from "zod";

// Unknown keys from removed settings are dropped, so older databases still parse.
export const notificationPreferencesSchema = z.object({ review: z.boolean().default(true), failed: z.boolean().default(true), done: z.boolean().default(true), dockBadge: z.boolean().default(true) });
export const workspaceSettingsSchema = z.object({ workspaceName: z.string().trim().min(1).max(100).default("Muster"), notifications: notificationPreferencesSchema.default({ review: true, failed: true, done: true, dockBadge: true }) });
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const apiKeyInputSchema = z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(["chief", "read"])).min(1).max(2) }).strict();
export interface ApiKey { id: string; name: string; prefix: string; scopes: ("chief" | "read")[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
