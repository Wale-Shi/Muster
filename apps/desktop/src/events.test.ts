import { afterEach, expect, it, vi } from "vitest";
import { watchEvents } from "./events.js";
afterEach(() => vi.unstubAllGlobals());
it("parses chunked SSE frames and supplies a replay cursor on reconnect", async () => {
  const abort = new AbortController();
  const seen: string[] = [];
  const encoder = new TextEncoder();
  let requests = 0;
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    requests++;
    if (requests === 2) expect(options.headers).toEqual({ "Last-Event-ID": "10" });
    const pieces = requests === 1 ? [": connected\n\nid: 10\nda", 'ta: {"type":"todo.changed","todoId":"first","payload":{"phase":"confirm"}}\n\n'] : ['id: 11\ndata: {"type":"todo.changed","todoId":"second","payload":{"phase":"review"}}\n\n'];
    return new Response(new ReadableStream({ start(controller) { for (const piece of pieces) controller.enqueue(encoder.encode(piece)); controller.close(); } }));
  });
  vi.stubGlobal("fetch", fetcher);
  await watchEvents("http://localhost:7420", abort.signal, async (event) => {
    seen.push(event.todoId!); if (seen.length === 2) abort.abort();
  });
  expect(seen).toEqual(["first", "second"]); expect(fetcher).toHaveBeenCalledTimes(2);
});
