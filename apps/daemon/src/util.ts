import { setTimeout } from "node:timers/promises";

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const delay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  try { await setTimeout(ms, undefined, signal ? { signal } : {}); }
  catch (error) { if (!signal?.aborted) throw error; }
};

/** Serializes git metadata operations, without serializing model execution. */
export class Mutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.tails.get(key) === current) this.tails.delete(key); }
  }
}

export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Unsafe workspace id: ${value}`);
  return value;
}
