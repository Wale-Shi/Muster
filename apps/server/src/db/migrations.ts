export const migrations = [
  `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_url TEXT NOT NULL, base_branch TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude','mock')), model TEXT NOT NULL, reasoning TEXT, avatar TEXT, is_chief INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, concurrency INTEGER NOT NULL, runtimes_json TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT NOT NULL, runtime_session_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE todos (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, spec TEXT NOT NULL, phase TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), plan_agent_id TEXT REFERENCES agents(id), mode TEXT NOT NULL, tags_json TEXT NOT NULL, created_by TEXT NOT NULL, topic_id TEXT REFERENCES topics(id), previous_gate TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT);
  CREATE TABLE builds (id TEXT PRIMARY KEY, todo_id TEXT REFERENCES todos(id), branch TEXT NOT NULL, machine_id TEXT REFERENCES machines(id), status TEXT NOT NULL, base_commit TEXT, head_commit TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE turns (id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(id), kind TEXT NOT NULL, status TEXT NOT NULL, machine_id TEXT REFERENCES machines(id), prompt TEXT NOT NULL, started_at TEXT, ended_at TEXT, error TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, session_state_json TEXT, stop_requested INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT REFERENCES turns(id), role TEXT NOT NULL, content TEXT NOT NULL, meta_json TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE documents (id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(id), kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(build_id, kind, version));
  CREATE TABLE queued_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, content TEXT NOT NULL, delivered_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE mcp_tokens (token TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id), created_at TEXT NOT NULL);
  CREATE INDEX turns_queue_idx ON turns(status);
  CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
  CREATE INDEX documents_build_idx ON documents(build_id, kind, version);
  `,
  `
  ALTER TABLE queued_messages ADD COLUMN source_message_id TEXT REFERENCES messages(id);
  ALTER TABLE queued_messages ADD COLUMN delivery_turn_id TEXT REFERENCES turns(id);
  ALTER TABLE turns ADD COLUMN agent_snapshot_json TEXT;
  ALTER TABLE turns ADD COLUMN completion_json TEXT;
  ALTER TABLE turns ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE turns ADD COLUMN last_reported_at TEXT;
  CREATE TABLE event_batches (turn_id TEXT NOT NULL REFERENCES turns(id), batch_id TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY(turn_id, batch_id));
  CREATE TABLE machine_claims (machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE, request_id TEXT NOT NULL, job_json TEXT NOT NULL, PRIMARY KEY(machine_id, request_id));
  CREATE TABLE server_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_json TEXT NOT NULL);
  CREATE INDEX turns_build_status_idx ON turns(build_id, status);
  `,
  `ALTER TABLE turns ADD COLUMN not_before TEXT;`,
  `
  ALTER TABLE agents ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE agents ADD COLUMN default_skill_ids_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE agents ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
  UPDATE agents SET updated_at=created_at, permissions_json=CASE WHEN is_chief=1 THEN '{"createSkills":true,"updateSkills":true}' ELSE '{}' END;
  CREATE TABLE agent_memories (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, content TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('user','agent')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX agent_memories_agent_idx ON agent_memories(agent_id, created_at);
  CREATE TABLE skills (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL, source_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE secrets (id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('team','project')), project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope, project_id, name), CHECK((scope='team' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL)));
  CREATE UNIQUE INDEX secrets_team_name ON secrets(name) WHERE scope='team';
  `,
] as const;
