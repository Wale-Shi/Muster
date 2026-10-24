import type { Connections } from "./resources/connections.js";
import type { Schedules } from "./resources/schedules.js";
import type { Memories } from "./resources/memories.js";
import type { Secrets } from "./resources/secrets.js";
import type { Skills } from "./resources/skills.js";
import type { MusterDb } from "./db/index.js";
import type { EventBus } from "./events.js";
import type { Orchestrator } from "./orchestrator/state.js";
import type { Scheduler } from "./orchestrator/scheduler.js";

export interface AppServices {
  connections: Connections;
  schedules: Schedules;
  memories: Memories;
  secrets: Secrets;
  skills: Skills;
  db: MusterDb;
  events: EventBus;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  enrollKey: string | null;
  claimWaitMs: number;
}
