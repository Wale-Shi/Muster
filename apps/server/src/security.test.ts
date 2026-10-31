import { afterEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp, type CreateAppOptions } from "./app.js";
import { requestJson } from "./test/helpers.js";

const databases: Array<ReturnType<typeof createApp>["services"]["db"]> = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

function setup(options: CreateAppOptions = {}): Hono {
  const { app, services } = createApp({ claimWaitMs: 0, autoFollowUp: false, ...options });
  databases.push(services.db);
  return app;
}
const project = { name: "Test", repoUrl: "/tmp/test-repo", baseBranch: "main" };
const post = (app: Hono, url: string, headers: Record<string, string>) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(project) });

describe("request security", () => {
  it("rejects a cross-site text/plain POST", async () => {
    const app = setup();
    expect((await app.request("http://127.0.0.1:7420/api/projects", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.test" }, body: JSON.stringify(project) })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:7420/api/projects", { method: "POST", headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" }, body: JSON.stringify(project) })).status).toBe(403);
    expect((await requestJson(app, "/api/projects")).json.data).toEqual([]);
  });
  it("rejects a foreign Host on reads and writes", async () => {
    const app = setup();
    expect((await app.request("http://attacker.example:7420/api/secrets")).status).toBe(403);
    expect((await post(app, "http://attacker.example:7420/api/projects", {})).status).toBe(403);
    const blocked = await app.request("http://attacker.example:7420/api/projects");
    expect(await blocked.json()).toEqual({ error: "Host not allowed" });
  });
  it("accepts a same-origin JSON POST and a JSON POST without Origin", async () => {
    const app = setup();
    expect((await post(app, "http://127.0.0.1:7420/api/projects", { origin: "http://127.0.0.1:7420" })).status).toBe(201);
    expect((await post(app, "http://localhost:7420/api/projects", { origin: "http://localhost:7420" })).status).toBe(201);
    expect((await post(app, "http://127.0.0.1:7420/api/projects", {})).status).toBe(201);
    expect((await app.request("http://[::1]:7420/api/projects")).status).toBe(200);
  });
  it("accepts the public URL host and its origin", async () => {
    const app = setup({ publicUrl: "https://muster.example.com" });
    expect((await post(app, "https://muster.example.com/api/projects", { origin: "https://muster.example.com" })).status).toBe(201);
    expect((await post(app, "https://muster.example.com/api/projects", { origin: "https://evil.test" })).status).toBe(403);
    expect((await app.request("http://other.example.com/api/projects")).status).toBe(403);
  });
  it("accepts an explicitly allowed host and rejects the others", async () => {
    const app = setup({ allowedHosts: ["muster.lan"] });
    expect((await post(app, "http://muster.lan:7420/api/projects", { origin: "http://muster.lan:7420" })).status).toBe(201);
    expect((await app.request("http://muster.example.com/api/projects")).status).toBe(403);
  });
  it("leaves /health reachable from any Host", async () => {
    const app = setup();
    expect((await app.request("http://attacker.example/health")).status).toBe(200);
  });
  it("rejects a non-JSON body on a JSON route", async () => {
    const app = setup();
    const response = await app.request("/api/projects", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(project) });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Expected application/json" });
    expect((await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(project) })).status).toBe(201);
    expect((await app.request("/api/settings", { method: "PATCH", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  });
  it("rejects a multipart upload from another origin but keeps same-origin uploads working", async () => {
    const app = setup(); let count = 0;
    const upload = (headers: Record<string, string>) => { const form = new FormData(); form.append("files", new File([`---\nname: Upload ${++count}\ndescription: Test\n---\nWork`], "SKILL.md")); return app.request("http://127.0.0.1:7420/api/skills/upload", { method: "POST", headers, body: form }); };
    expect((await upload({ origin: "https://evil.test" })).status).toBe(403);
    expect((await upload({ origin: "http://127.0.0.1:7420" })).status).toBe(201);
    expect((await upload({})).status).toBe(201);
  });
  it("answers unmatched API and MCP paths with JSON 404 instead of the app document", async () => {
    const app = setup();
    for (const path of ["/api/does-not-exist", "/api", "/mcp/unknown"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
  });
});
