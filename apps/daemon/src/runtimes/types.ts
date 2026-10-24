import type { AgentEvent, TurnJob } from "@muster/shared";
export interface RuntimeContext { cwd: string; emit(event: AgentEvent): void }
export interface RuntimeResult {
  status: "done" | "failed" | "stopped";
  text: string;
  usage: { tokensIn: number; tokensOut: number };
  sessionState: Record<string, unknown>;
  error?: string;
}
export interface RunningTurn {
  result: Promise<RuntimeResult>;
  steer(content: string): Promise<void>;
  interrupt(): Promise<void>;
}
export interface Runtime { start(job: TurnJob, ctx: RuntimeContext): RunningTurn }
