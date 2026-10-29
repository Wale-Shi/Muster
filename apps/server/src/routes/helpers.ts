import type { Context } from "hono";
import type { z } from "zod";
import { StateError } from "../orchestrator/state.js";

// A plain-text body is what a cross-site page can send without a CORS preflight, so JSON routes
// insist on a JSON content type instead of sniffing whatever bytes arrived.
export async function jsonBody(context: Context): Promise<unknown> {
  const type = context.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type !== "application/json" && !type.endsWith("+json")) throw new StateError("Expected application/json", 415);
  return context.req.json();
}

export async function body<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try { value = await jsonBody(context); }
  catch (error) { if (error instanceof StateError) throw error; value = undefined; }
  return schema.parse(value);
}

export function bearer(context: Context): string | null {
  const authorization = context.req.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}
