import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("node:child_process", () => ({ fork: () => state.child }));
import { Worker } from "./workers.js";

afterEach(() => { vi.useRealTimers(); });
it("force kills a worker after ten seconds if graceful shutdown hangs", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: null, stderr: null,
    send: vi.fn(),
    kill: vi.fn((signal: string) => { if (signal === "SIGKILL") child.emit("exit", null); }),
  });
  state.child = child;
  const worker = new Worker("entry", [], {}, "/tmp", "daemon");
  const stopping = worker.stop();
  await vi.advanceTimersByTimeAsync(9999);
  expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  await vi.advanceTimersByTimeAsync(1);
  await stopping;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});
it("clears the force kill deadline after a graceful exit", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, send: vi.fn(), kill: vi.fn() });
  state.child = child;
  const worker = new Worker("entry", [], {}, "/tmp", "daemon");
  const stopping = worker.stop();
  child.emit("exit", 0); await stopping;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
});
