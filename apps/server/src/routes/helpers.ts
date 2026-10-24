import type { Context } from "hono";
import type { z } from "zod";

export async function body<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  const value: unknown = await context.req.json().catch(() => undefined);
  return schema.parse(value);
}

export function bearer(context: Context): string | null {
  const authorization = context.req.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}
