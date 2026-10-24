import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { chooseServer, isMuster, portAvailable } from "./ports.js";
describe("desktop server discovery", () => {
  it("attaches to Muster on 7420 without trying to bind", async () => {
    const result = await chooseServer(7420, async () => true, async () => { throw new Error("must not bind"); });
    expect(result).toEqual({ port: 7420, attach: true });
  });
  it("skips unrelated occupied ports", async () => {
    expect(await chooseServer(7420, async () => false, async (p) => p === 7422)).toEqual({ port: 7422, attach: false });
  });
  it("recognizes old servers and rejects generic health endpoints", async () => {
    let muster = false;
    const server = createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.url === "/health" ? { status: "ok" } : muster ? { data: [] } : { unrelated: true })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await portAvailable(port)).toBe(false);
      expect(await isMuster(`http://127.0.0.1:${port}`)).toBe(false);
      muster = true; expect(await isMuster(`http://127.0.0.1:${port}`)).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("rejects unavailable services", async () => { expect(await isMuster("http://127.0.0.1:0")).toBe(false); });
});
