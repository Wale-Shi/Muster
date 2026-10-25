import { describe, expect, it } from "vitest";
import { taskCommitMessage, taskMetadata } from "./task-commit.js";

const todo = { id: "task /?#", number: 7, title: "修复提交", spec: "\n First line\r\nsecond line\r\n \r\nIgnore this paragraph" };

describe("task commit metadata", () => {
  it.each([
    ["https://muster.example/base/", "https://muster.example/base/todos/task%20%2F%3F%23"],
    ["http://127.0.0.1:7420", "http://127.0.0.1:7420/todos/task%20%2F%3F%23"],
    ["https://muster.example/base/?query=1#hash", "https://muster.example/base/todos/task%20%2F%3F%23"],
    ["", "/todos/task%20%2F%3F%23"],
    ["bad URL", "/todos/task%20%2F%3F%23"],
    ["javascript:alert(1)", "/todos/task%20%2F%3F%23"],
    ["https://user:secret@example.com", "/todos/task%20%2F%3F%23"],
  ])("builds a link from %s", (base, expected) => {
    expect(taskMetadata(todo, base)).toEqual({ number: 7, title: todo.title, summary: "First line second line", url: expected });
  });

  it("limits summaries by code point and uses the title for an empty spec", () => {
    const summary = taskMetadata({ ...todo, spec: "😀".repeat(501) }, "").summary;
    expect(Array.from(summary)).toHaveLength(500);
    expect(summary.endsWith("😀…")).toBe(true);
    expect(taskMetadata({ ...todo, spec: "\r\n \t" }, "").summary).toBe(todo.title);
  });

  it.each(["checkpoint", "merge"] as const)("bounds and sanitizes the %s subject", (kind) => {
    const task = taskMetadata({ ...todo, title: '中文\n\r\0\t"$()`x` ' + "😀".repeat(80) }, "");
    const message = taskCommitMessage({ todoId: todo.id, task }, kind, "fallback", 2);
    const subject = message.split("\n")[0]!;
    expect(Array.from(subject)).toHaveLength(72);
    expect(subject).toContain('中文 "$()`x`');
    expect(subject.endsWith("😀…")).toBe(true);
    expect(message).not.toMatch(/[\r\0\t]/);
    if (kind === "checkpoint") expect(message).toContain("\n\nTurn: 2");
    else {
      expect(message).toContain("First line second line");
      expect(message).toContain("Task: /todos/task%20%2F%3F%23 (relative Muster URL)");
      expect(message).toContain(`Task ID: ${todo.id}`);
    }
  });

  it("preserves old job behavior and rejects unusable task metadata", () => {
    expect(taskCommitMessage({ todoId: "old" }, "merge", "old merge")).toBe("old merge");
    for (const task of [{ ...taskMetadata(todo, ""), title: "\n" }, { ...taskMetadata(todo, ""), number: 0 }]) {
      expect(taskCommitMessage({ todoId: "old", task }, "checkpoint", "old checkpoint", 1)).toBe("old checkpoint");
    }
  });
});
