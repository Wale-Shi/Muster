import { messages } from "./zh-CN";
import type { createI18n, MessageKey } from ".";
// Server errors are English; known ones are shown from the dictionary.
const serverErrors: Record<string, keyof typeof messages.error> = {
  "API key not found": "apiKeyNotFound",
  "Agent has running work": "agent_busy",
  "Skill not found": "skill_missing",
  "Skills must contain 1–200 files": "skill_count",
  "Invalid skill file path": "skill_path",
  "Skill exceeds 5 MB": "skill_size",
  "SKILL.md requires YAML name and description": "skill_frontmatter",
  "Invalid SKILL.md frontmatter or empty instructions": "skill_invalid_frontmatter",
  "Use a public https://github.com/owner/repo URL": "github_url",
  "Invalid GitHub skill URL": "github_invalid",
  "Skill symlinks are not allowed": "skill_symlink",
  "Skill exceeds 5 MB or 200 files": "skill_limits",
  "Only regular skill files are allowed": "skill_regular",
  "Could not import GitHub skill. Check that the public repository, branch and folder exist.": "github_failed",
  "Skill version changed; retry the task": "skill_changed",
  "Folder must contain SKILL.md": "skill_manifest",
  "Skill name must produce a valid slug": "skill_slug",
  "A skill with this slug already exists": "skill_duplicate",
  "Upload exceeds 5 MB": "upload_size",
  "Expected skill files": "upload_files",
  "No SKILL.md found": "upload_empty",
  "Choose bulk import for multiple skills": "upload_bulk",
  "Invalid request": "invalid_request",
  "Internal server error": "internal_error",
  "Resource is still in use": "in_use",
  "Project not found": "project_missing",
  "Agent not found": "agent_missing",
  "Todo not found": "todo_missing",
  "Machine not found": "machine_missing",
  "Document not found": "document_missing",
  "Turn not found": "turn_missing",
  "No agent available": "no_agent",
  "Wait for the closed turn to stop before reopening": "wait_stop",
  "Todo has no running turn": "no_running",
  "Todo has no queued turn": "no_queued",
  "Unexpected server response": "response",
  "This action is unavailable in {phase}.": "phase",
  "Request failed ({status})": "request",
  "Queued message not found": "queued_missing",
  "Message is already being delivered": "delivering",
  "Workspace not found": "workspace_missing",
  "Workspace still has tasks": "workspace_busy",
  "Master agent is still working": "master_busy",
  "The default master agent cannot be deleted": "default_master",
  "Workspace conversation not found": "workspace_conversation",
  "Topic not found": "topic_missing"
};
const known = new Map(Object.entries(serverErrors).map(([text, key]) => [text, `error.${key}` as MessageKey]));
export function displayError(error: unknown, t: ReturnType<typeof createI18n>["t"], label: ReturnType<typeof createI18n>["label"]) {
  const text = error instanceof Error ? error.message : String(error);
  const key = known.get(text);
  if (key) return t(key);
  const phase = text.match(/^(?:Cannot (?:start|complete|reopen|rerun) todo from |Messages cannot be sent from |Turn is )(\w+)$/)?.[1] ?? text.match(/^Messages can only steer a running turn or revise at review \(current: (\w+)\)$/)?.[1];
  if (phase && Object.hasOwn(messages.phase, phase)) return t("error.phase", { phase: label("phase", phase) });
  const status = text.match(/^Request failed \((\d+)\)$/)?.[1];
  return status ? t("error.request", { status }) : text;
}
