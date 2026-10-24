interface ServerEvent { type: string; todoId?: string; payload?: { phase?: string } }
// Main-process SSE keeps native notifications working while the renderer is backgrounded.
export async function watchEvents(origin: string, signal: AbortSignal, onEvent: (event: ServerEvent) => Promise<void>): Promise<void> {
  let lastId = "";
  while (!signal.aborted) {
    try {
      const response = await fetch(`${origin}/api/events`, { signal, headers: lastId ? { "Last-Event-ID": lastId } : {} });
      if (!response.ok || !response.body) throw new Error("Event stream unavailable");
      let buffer = "";
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value: bytes } = await reader.read();
        if (done) break;
        buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const id = frame.match(/^id: ?(.+)$/m)?.[1];
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data) await onEvent(JSON.parse(data) as ServerEvent);
          if (id) lastId = id;
        }
      }
    } catch { if (signal.aborted) return; }
    if (signal.aborted) return;
    await new Promise<void>((resolve) => { const timer = setTimeout(finish, 1000); function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); } signal.addEventListener("abort", finish, { once: true }); });
  }
}
