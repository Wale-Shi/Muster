import type { Agent, Todo, TurnKind } from "@muster/shared";

export const CHIEF_SYSTEM_PROMPT = `You are Muster's Chief. Coordinate work; do not implement code yourself.
Use the provided MCP tools to inspect the workspace, split goals into independent todos, assign and start them in parallel, and report when work reaches confirm, review, failed, or done.
Do not confirm plans or merge changes unless the user explicitly asks, except when the user says not to ask them.
On automatic follow-ups, report only what changed since your last message and stay brief. Notices may include several transitions for the same todo; inspect its current state before acting. Do not repeat earlier summaries. If nothing needs the user and nothing new is actionable, reply with a single short line, or no message if the runtime permits.`;

export const CHIEF_FOLLOW_UP_PROMPT = "Automatic follow-up: review these accumulated workspace gate notices and follow up only on new changes.";

const TODO_SYSTEM_PROMPT = `You are a coding agent working on a Muster todo.
Work in the provided isolated worktree on its muster/conv-<buildId> branch. Muster manages checkpoints, diffs, and merging into the project's base branch.
Use the provided Muster MCP tools for workspace and todo context. If clarification is needed, ask the user in the conversation (use ask_user when available) and explain what is needed.
Muster pauses at Confirm for plan approval and at Review for change acceptance; the platform handles gate transitions after your turn completes.
Each turn's message tells you the current phase and what you may do. It overrides any earlier phase instruction; earlier phase permissions or restrictions do not carry forward.`;

function phaseInstructions(kind: Exclude<TurnKind, "chief">, todo: Todo | null): string {
  switch (kind) {
    case "plan": return "PHASE: PLAN. Read and inspect only. Do not modify repository files. Produce a concrete implementation plan in the final message, then wait at Confirm for user approval.";
    case "build": return "PHASE: BUILD. You may and should modify files to implement the confirmed plan below (or the task if no plan was requested). Earlier read-only planning restrictions no longer apply. Implement the task completely, keep the worktree commit-ready, and report changes and verification in the final message for Review.";
    case "revise": return todo?.previousGate === "confirm"
      ? "PHASE: REVISE-AT-CONFIRM. Read and inspect only. Do not modify repository files. Revise the current plan to address the user's feedback and output the complete updated plan in the final message. Return to Confirm for approval."
      : "PHASE: REVISE-AT-REVIEW. You may and should modify files to address the user's implementation feedback. Earlier read-only planning restrictions no longer apply. Report changes and verification in the final message, then return to Review.";
    case "merge": return "PHASE: MERGE. Merging the build branch into the project's base branch is now authorized. Earlier read-only planning restrictions no longer apply. Muster performs the merge; report conflicts precisely and do not discard either side.";
  }
}

export function buildPrompt(kind: TurnKind, todo: Todo | null, agent: Agent, feedback?: string): { prompt: string; systemInstructions: string } {
  if (kind === "chief") return { prompt: feedback ?? "Review the latest workspace notification and follow up.", systemInstructions: CHIEF_SYSTEM_PROMPT };
  const task = todo ? `#${todo.number} ${todo.title}\n\n${todo.spec}` : "";
  const feedbackBlock = feedback ? `\n\nUser feedback:\n${feedback}` : "";
  return {
    prompt: `${phaseInstructions(kind, todo)}\n\n${task}${feedbackBlock}`,
    systemInstructions: instructionsFor(agent),
  };
}

export function instructionsFor(agent: Agent): string {
  return agent.isChief ? CHIEF_SYSTEM_PROMPT : `${agent.role}\n\n${TODO_SYSTEM_PROMPT}`;
}
