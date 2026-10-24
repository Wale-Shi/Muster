import type { AgentEvent } from "@muster/shared";
import type { MachineClient } from "./client.js";

export class EventBatcher {
  private queue: AgentEvent[] = [];
  private flight: Promise<void> | undefined;
  private timer: NodeJS.Timeout;
  constructor(private client: MachineClient, private turnId: string, private onError: (error: unknown) => void, flushMs = 250) {
    this.timer = setInterval(() => { void this.flush().catch(this.onError); }, flushMs);
  }
  emit = (event: AgentEvent): void => { this.queue.push(event); };
  async flush(): Promise<void> {
    if (this.flight) return this.flight;
    const send = async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 200);
        try { await this.client.events(this.turnId, batch); }
        catch (error) { this.queue.unshift(...batch); throw error; }
      }
    };
    this.flight = send();
    try { await this.flight; }
    finally { this.flight = undefined; }
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    // A periodic flush may have completed just before the last event was queued.
    if (this.queue.length) await this.flush();
  }
}
