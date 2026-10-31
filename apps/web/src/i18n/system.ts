import type { Message } from "@muster/shared";
import { messages } from "./zh-CN";
import type { createI18n } from ".";

export function systemMessage(message: Message, t: ReturnType<typeof createI18n>["t"], label: ReturnType<typeof createI18n>["label"]) {
  const { phase, todoId, todoNumber, todoTitle, code } = message.meta;
  if (code === "connection_machine_mismatch" && typeof message.meta.connectionName === "string") return t("phaseB.machineOmitted", { name: message.meta.connectionName });
  if (code === "no_file_changes") return t("text.noChanges");
  if (typeof phase === "string" && Object.hasOwn(messages.phase, phase) && typeof todoId === "string") {
    const legacy = message.content.match(/^(?:Todo|Task) (#[\s\S]+?)(?: \(taskId [^)]+\))? entered \w+\.$/);
    const task = typeof todoNumber === "number" && typeof todoTitle === "string" ? `#${todoNumber} ${todoTitle}` : legacy?.[1] ?? todoId;
    return Object.hasOwn(messages.system, phase) ? t(`system.${phase as keyof typeof messages.system}`, { task }) : t("text.systemPhase", { task, phase: label("phase", phase) });
  }
  return message.content;
}
