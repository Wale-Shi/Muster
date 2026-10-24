import { createServer } from "node:net";

export async function isMuster(origin: string): Promise<boolean> {
  try {
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(800) });
    const value = await health.json() as { status?: string; service?: string };
    if (!health.ok || value.status !== "ok") return false;
    if (value.service === "muster") return true;
    // Accept pre-desktop Muster servers, whose health endpoint had no service ID.
    const response = await fetch(`${origin}/api/topics`, { signal: AbortSignal.timeout(800) });
    const topics = await response.json() as { data?: unknown };
    return response.ok && Array.isArray(topics.data);
  } catch { return false; }
}
export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve(true)));
  });
}
export async function chooseServer(start = 7420, probe = isMuster, available = portAvailable): Promise<{ port: number; attach: boolean }> {
  for (let port = start; port <= 65535; port++) {
    if (await probe(`http://127.0.0.1:${port}`)) return { port, attach: true };
    if (await available(port)) return { port, attach: false };
  }
  throw new Error("No free local port for Muster");
}
