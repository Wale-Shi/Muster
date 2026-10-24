import type { ServerEvent } from "@muster/shared";

type Listener = (event: ServerEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
