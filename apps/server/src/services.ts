import type { Settings } from "./resources/settings.js";
import type { Connections } from "./resources/connections.js";
import type { Skills } from "./resources/skills.js";
import type { MusterDb } from "./db/index.js";
import type { EventBus } from "./events.js";
import type { Orchestrator } from "./orchestrator/state.js";
import type { Scheduler } from "./orchestrator/scheduler.js";

export interface AppServices {
  settings: Settings;
  dataDir: string;
  connections: Connections;
  skills: Skills;
  db: MusterDb;
  events: EventBus;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  enrollKey: string | null;
  claimWaitMs: number;
}
