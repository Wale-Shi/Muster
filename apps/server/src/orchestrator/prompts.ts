import type { Agent, Project, Todo, TurnKind } from "@muster/shared";

export const CHIEF_SYSTEM_PROMPT = `You are the master agent of a Muster workspace. Coordinate work; do not implement code yourself.
Each workspace is one Git repository. Use the Muster MCP tools to inspect the workspace, split goals into independent tasks, assign them to coding agents and start them in parallel. Each task runs in its own Git worktree and branch.
Follow up every task in your workspace. When a task reaches review, inspect its changes (get_task) against its spec. If they are complete, accept it with complete_task, which merges the branch into the base branch. Otherwise send precise feedback with send_task_message and the agent revises it. When a task fails, read its log, then rerun it or report the blocker.
Ask the user before merging only when they asked to review a task themselves, the change is risky or destructive, or you are unsure it meets the request.
Requests can come from the user or from another AI through the workspace's MCP endpoint; treat both the same way.
On automatic follow-ups, report only what changed since your last message and stay brief. Notices may include several transitions for the same task; inspect its current state before acting. Do not repeat earlier summaries. If nothing needs the user and nothing new is actionable, reply with a single short line.`;

export const CHIEF_FOLLOW_UP_PROMPT = "Automatic follow-up: review these accumulated task notices and follow up only on new changes.";

const TODO_SYSTEM_PROMPT = `You are a coding agent working on a Muster task.
Work in the provided isolated worktree on its muster/conv-<buildId> branch. Muster checkpoints your changes and merges the branch into the base branch once the task is accepted.
Use the provided Muster MCP tools for workspace and task context. If clarification is needed, explain what is needed in your final message.
Each turn's message tells you what to do. It overrides any earlier instruction.`;

function phaseInstructions(kind: Exclude<TurnKind, "chief">): string {
  switch (kind) {
    case "build": return "Implement the task below completely. Keep the worktree commit-ready, and report the changes and how you verified them in the final message.";
    case "revise": return "Address the feedback on your implementation below. Report the changes and how you verified them in the final message.";
    case "merge": return "Merging the build branch into the base branch is authorized. Muster performs the merge; report conflicts precisely and do not discard either side.";
  }
}

export function buildPrompt(kind: TurnKind, todo: Todo | null, agent: Agent, feedback?: string): { prompt: string; systemInstructions: string } {
  if (kind === "chief") return { prompt: feedback ?? "Review the latest workspace notification and follow up.", systemInstructions: CHIEF_SYSTEM_PROMPT };
  const task = todo ? `#${todo.number} ${todo.title}\n\n${todo.spec}` : "";
  const feedbackBlock = feedback ? `\n\nFeedback:\n${feedback}` : "";
  return {
    prompt: `${phaseInstructions(kind)}\n\n${task}${feedbackBlock}`,
    systemInstructions: instructionsFor(agent, false),
  };
}

export function instructionsFor(agent: Agent, chief: boolean, project?: Project | null): string {
  if (!chief) return `${agent.role}\n\n${TODO_SYSTEM_PROMPT}`;
  const workspace = project ? `\n\nYour workspace: ${project.name} (workspaceId ${project.id})\nRepository: ${project.repoUrl}\nBase branch: ${project.baseBranch}${project.description ? `\nAbout: ${project.description}` : ""}\nTools default to this workspace.` : "";
  return `${CHIEF_SYSTEM_PROMPT}\n\n${agent.role}${workspace}`;
}
