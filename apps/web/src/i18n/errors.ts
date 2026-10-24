import { en } from "./en";
import type { createI18n, MessageKey } from ".";
const known = new Map(Object.entries(en.error).map(([key, text]) => [text as string, `error.${key}` as MessageKey]));
export function displayError(error: unknown, t: ReturnType<typeof createI18n>["t"], label: ReturnType<typeof createI18n>["label"]) {
  const text = error instanceof Error ? error.message : String(error);
  const key = known.get(text);
  if (key) return t(key);
  const phase = text.match(/^(?:Cannot (?:start|confirm|complete|reopen|rerun) todo from |Messages cannot be sent from |Turn is )(\w+)$/)?.[1] ?? text.match(/^Messages can only steer a running turn or revise at a gate \(current: (\w+)\)$/)?.[1];
  if (phase && Object.hasOwn(en.phase, phase)) return t("error.phase", { phase: label("phase", phase) });
  const status = text.match(/^Request failed \((\d+)\)$/)?.[1];
  return status ? t("error.request", { status }) : text;
}
