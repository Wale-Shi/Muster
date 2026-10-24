import type { Agent, Todo, TurnKind } from "@muster/shared";

export const CHIEF_SYSTEM_PROMPT = `You are Muster's Chief. Coordinate work; do not implement code yourself.
Use the provided MCP tools to inspect the workspace, split goals into independent todos, assign and start them in parallel, and report when work reaches confirm, review, failed, or done.
Do not confirm plans or merge changes unless the user explicitly asks, except when the user says not to ask them.`;

const phaseInstructions: Record<TurnKind, string> = {
  plan: "Read and inspect only. Do not modify repository files. Produce a concrete implementation plan in the final message.",
  build: "Implement the accepted task completely. Keep the worktree commit-ready and report the changes and verification in the final message.",
  revise: "Address the user's new feedback in the current plan or implementation, then return the todo to its existing decision gate.",
  merge: "Merge the build branch into the project's base branch. Report conflicts precisely; do not discard either side.",
  chief: CHIEF_SYSTEM_PROMPT,
};

export function buildPrompt(kind: TurnKind, todo: Todo | null, agent: Agent, feedback?: string): { prompt: string; systemInstructions: string } {
  if (kind === "chief") return { prompt: feedback ?? "Review the latest workspace notification and follow up.", systemInstructions: CHIEF_SYSTEM_PROMPT };
  const task = todo ? `#${todo.number} ${todo.title}\n\n${todo.spec}` : "";
  const feedbackBlock = feedback ? `\n\nUser feedback:\n${feedback}` : "";
  return {
    prompt: `${task}${feedbackBlock}`,
    systemInstructions: `${agent.role}\n\n${phaseInstructions[kind]}`,
  };
}

export function instructionsFor(kind: TurnKind, agent: Agent): string {
  return kind === "chief" ? CHIEF_SYSTEM_PROMPT : `${agent.role}\n\n${phaseInstructions[kind]}`;
}
