import type { TurnJob } from "./protocol.js";

type Task = NonNullable<TurnJob["task"]>;

function singleLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

function truncate(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit ? value : characters.slice(0, limit - 1).join("") + "…";
}

export function taskMetadata(todo: { id: string; number: number; title: string; spec: string }, publicUrl: string): Task {
  const path = `/todos/${encodeURIComponent(todo.id)}`;
  let url = path;
  try {
    const base = new URL(publicUrl);
    if (["http:", "https:"].includes(base.protocol) && !base.username && !base.password) {
      base.search = "";
      base.hash = "";
      base.pathname = base.pathname.replace(/\/+$/, "") + path;
      url = base.href;
    }
  } catch { /* Keep a relative task link when no usable public URL is configured. */ }
  const paragraph = todo.spec.trim().split(/\r?\n\s*\r?\n/)[0] ?? "";
  return { number: todo.number, title: todo.title, summary: truncate(singleLine(paragraph) || singleLine(todo.title), 500), url };
}

export function taskCommitMessage(job: Pick<TurnJob, "todoId" | "task">, kind: "checkpoint" | "merge", fallback: string, turnNumber?: number): string {
  const task = job.task;
  if (!task || !Number.isSafeInteger(task.number) || task.number < 1 || !singleLine(task.title)) return fallback;
  const prefix = kind === "merge" ? `Merge #${task.number}: ` : `#${task.number} `;
  const subject = prefix + truncate(singleLine(task.title), 72 - Array.from(prefix).length);
  if (kind === "checkpoint") return `${subject}\n\nTurn: ${turnNumber}`;
  const relative = task.url.startsWith("/");
  const url = singleLine(task.url) || `/todos/${encodeURIComponent(job.todoId ?? "")}`;
  return `${subject}\n\n${singleLine(task.summary) || singleLine(task.title)}\n\nTask: ${url}${relative || !task.url ? " (relative Muster URL)" : ""}\nTask ID: ${singleLine(job.todoId ?? "unknown")}`;
}
