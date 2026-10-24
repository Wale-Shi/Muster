import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnJob } from "@muster/shared";
import type { Runtime, RuntimeContext, RunningTurn } from "./types.js";
import { delay } from "../util.js";

export class MockRuntime implements Runtime {
  constructor(private chunkDelayMs = 25) {}
  start(job: TurnJob, ctx: RuntimeContext): RunningTurn {
    const abort = new AbortController();
    const queued: string[] = [];
    let finished = false;
    const result = (async () => {
      const text = job.readOnly ? `# Plan\n\n1. Inspect the project.\n2. Implement: ${job.prompt}\n3. Verify the changes.\n` : job.project ? `Implemented: ${job.prompt}\n` : `Chief: ${job.prompt}\n`;
      ctx.emit({ type: "status", status: "running" });
      let output = "";
      for (const chunk of text.match(/.{1,16}|\n/g) ?? []) {
        await delay(this.chunkDelayMs, abort.signal);
        if (abort.signal.aborted) break;
        output += chunk;
        ctx.emit({ type: "message.delta", content: chunk });
      }
      if (!abort.signal.aborted && !job.readOnly && job.project) {
        ctx.emit({ type: "tool.started", tool: "write_file", input: "MUSTER_MOCK.md" });
        await appendFile(join(ctx.cwd, "MUSTER_MOCK.md"), `# Muster mock turn\n\n${job.prompt}\n`);
        ctx.emit({ type: "tool.completed", tool: "write_file", output: "MUSTER_MOCK.md" });
      }
      for (const content of queued) {
        output += `\nSteer: ${content}\n`;
        ctx.emit({ type: "message.delta", content: `\nSteer: ${content}\n` });
      }
      if (job.readOnly && !abort.signal.aborted) ctx.emit({ type: "plan.updated", content: output });
      ctx.emit({ type: "message.completed", content: output });
      const usage = { tokensIn: job.prompt.length, tokensOut: output.length };
      ctx.emit({ type: "usage", ...usage });
      finished = true;
      return { status: abort.signal.aborted ? "stopped" as const : "done" as const, text: output, usage, sessionState: { mock: true, turns: Number(job.sessionState?.turns ?? 0) + 1 } };
    })();
    return { result, steer: async (content) => { if (finished) throw new Error("Turn already completed"); queued.push(content); }, interrupt: async () => { abort.abort(); } };
  }
}
