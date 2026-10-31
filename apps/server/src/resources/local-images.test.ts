import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink, link, chmod, rename } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import { createTodo, enroll, requestJson, seedProjectAndAgent } from "../test/helpers.js";
import { imageLimit, imagePath, mapImagePath, readImage, safeRead } from "./local-images.js";
import { referencesImage } from "../routes/local-images.js";

vi.mock("node:fs/promises", async (original) => {
  const module = await original<typeof import("node:fs/promises")>();
  return { ...module, open: vi.fn(module.open) };
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMoKPgPRAwQCgAyNgd9JQZITgAAAABJRU5ErkJggg==", "base64");
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), "muster-images-"))); cleanup.push(() => rm(root, { recursive: true, force: true })); return root; }
async function setup() {
  const dataDir = await directory(); const { app, services } = createApp({ dataDir, claimWaitMs: 0, autoFollowUp: false }); cleanup.push(() => services.db.close());
  const { projectId, agentId } = await seedProjectAndAgent(app), todoId = await createTodo(app, projectId, agentId), machine = await enroll(app);
  await writeFile(join(dataDir, "machine.json"), JSON.stringify(machine));
  await requestJson(app, `/api/todos/${todoId}/start`, "POST", {});
  const { json: job } = await requestJson(app, "/api/machine/claim", "POST", {}, machine.token);
  const buildId = job.buildId as string;
  async function request(src: string, options: { content?: string; role?: "agent" | "user"; todoId?: string; buildId?: string; origin?: string; header?: string } = {}) {
    const messageId = services.orchestrator.addMessage(buildId, job.turnId, options.role ?? "agent", options.content ?? `![Screenshot](<${src}>)`, {});
    return app.request(`/api/todos/${options.todoId ?? todoId}/images`, { method: "POST", headers: { "content-type": "application/json", "x-muster-image": options.header ?? "1", ...(options.origin ? { origin: options.origin } : {}) }, body: JSON.stringify({ buildId: options.buildId ?? buildId, messageId, src }) });
  }
  async function file(part: string, bytes = png) { const path = join(dataDir, part); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, bytes); return path; }
  return { app, services, dataDir, todoId, buildId, machine, job, request, file };
}
it("serves only referenced images in the current build and shared data, with private headers", async () => {
  const f = await setup();
  for (const part of [`artifacts/${f.buildId}/截图 space.png`, `workspaces/${f.buildId}/screen.png`, "screenshots/shared.png"]) {
    const path = await f.file(part), response = await f.request(path);
    expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get("content-type")).toBe("image/png"); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
});
it("rejects other builds, caches, temporary files and path-prefix collisions", async () => {
  const f = await setup();
  for (const path of [await f.file("artifacts/other/screen.png"), await f.file("workspaces/other/screen.png"), await f.file("workspaces/project/repo/screen.png"), join(await directory(), "screen.png"), `${f.dataDir}-other/screen.png`, "/tmp/screen.png"]) expect((await f.request(path)).status).toBe(403);
});
it("binds requests to task/build/agent message and actual Markdown images", async () => {
  const f = await setup(), path = await f.file(`artifacts/${f.buildId}/screen.png`);
  for (const options of [{ todoId: "other" }, { buildId: "other" }, { role: "user" as const }, { content: `[link](${path})` }, { content: `\`![fake](${path})\`` }, { content: `\`\`\`\n![fake](${path})\n\`\`\`` }]) expect((await f.request(path, options)).status).toBe(404);
  expect((await f.request(path, { content: `![ref][screen]\n\n[screen]: <${path}>` })).status).toBe(200);
  expect(referencesImage(`![x](</other.png>)`, path)).toBe(false);
});
it("rejects foreign origins and requests without the fetch-only header", async () => {
  const f = await setup(), path = await f.file("image.png");
  expect((await f.request(path, { origin: "https://evil.test" })).status).toBe(403);
  expect((await f.request(path, { header: "" })).status).toBe(403);
});
it("does not mistake a remote machine's matching path for a local file", async () => {
  const f = await setup(), path = await f.file("image.png");
  await rm(join(f.dataDir, "machine.json"));
  expect((await f.request(path)).status).toBe(409);
  await writeFile(join(f.dataDir, "machine.json"), JSON.stringify({ machineId: f.machine.machineId, token: "invalid" }));
  expect((await f.request(path)).status).toBe(409);
});
it("reports missing, unsupported, oversized and unreadable files without returning bytes", async () => {
  const f = await setup();
  expect((await f.request(join(f.dataDir, "missing.png"))).status).toBe(404);
  expect((await f.request(await f.file("fake.png", Buffer.from("<html>secret</html>")))).status).toBe(415);
  expect((await f.request(await f.file("vector.svg"))).status).toBe(415);
  const large = Buffer.alloc(imageLimit + 1); png.copy(large);
  expect((await f.request(await f.file("large.png", large))).status).toBe(413);
  expect((await f.request(await f.file("boundary.png", large.subarray(0, imageLimit)))).status).toBe(200);
  const path = await f.file("private.png"); await chmod(path, 0);
  expect((await f.request(path)).status).toBe(403);
});
it.each(["png", "jpg", "jpeg", "gif", "webp"])("accepts %s signatures and rejects mismatched extensions", async (extension) => {
  const root = await directory();
  const bytes = extension === "png" ? png : ["jpg", "jpeg"].includes(extension) ? Buffer.from([255, 216, 255, 224]) : extension === "gif" ? Buffer.from("GIF89a") : Buffer.from("RIFF1234WEBP");
  const path = join(root, `image.${extension}`); await writeFile(path, bytes);
  expect((await readImage(root, path)).mime).toMatch(/^image\//);
  await writeFile(path, Buffer.from("not an image")); await expect(readImage(root, path)).rejects.toThrow("Unsupported");
});
it.each(["/safe/../outside.png", "/safe/%2e%2e/outside.png", "/safe/%252e%252e/outside.png", "/safe/bad%zz.png", "/safe/\0.png", "file://remote/safe.png"])("rejects ambiguous or traversing input %j", (path) => {
  expect(() => imagePath(path)).toThrow();
});
it("rejects symlink files, parents, build roots and hardlinks", async () => {
  const f = await setup(), outside = await directory(); await writeFile(join(outside, "secret.png"), png);
  const buildDir = join(f.dataDir, "artifacts", f.buildId); await mkdir(buildDir, { recursive: true });
  await symlink(join(outside, "secret.png"), join(buildDir, "link.png"));
  await symlink(outside, join(buildDir, "parent"));
  await link(join(outside, "secret.png"), join(buildDir, "hard.png"));
  for (const part of ["link.png", "parent/secret.png", "hard.png"]) expect((await f.request(join(buildDir, part))).status).toBe(403);
  await rm(buildDir, { recursive: true }); await symlink(outside, buildDir);
  expect((await f.request(join(buildDir, "secret.png"))).status).toBe(403);
});
it("rejects a file replaced between path inspection and open", async () => {
  const root = await directory(), path = join(root, "image.png"); await writeFile(path, png);
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
    await rename(path, join(root, "old.png")); await writeFile(path, png);
    return original(...args);
  });
  await expect(safeRead(root, path, imageLimit)).rejects.toThrow("not allowed");
});
it("maps only an administrator-selected build subtree, excluding other build artifacts", () => {
  const mapping = { machineId: "remote", sourceDataDir: "/remote/data", dataDir: "/local/data", sourceWorkspacesDir: "/remote/ws", workspacesDir: "/shared/ws" };
  expect(mapImagePath("/remote/data/artifacts/build/screen.png", "build", mapping)).toEqual({ root: "/local/data", path: "/local/data/artifacts/build/screen.png" });
  expect(mapImagePath("/remote/ws/build/screen.png", "build", mapping)).toEqual({ root: "/shared/ws", path: "/shared/ws/build/screen.png" });
  expect(() => mapImagePath("/remote/data/artifacts/other/screen.png", "build", mapping)).toThrow();
});
it("accepts percent-encoded Markdown image URLs without losing message binding", async () => {
  const f = await setup(), path = await f.file(`artifacts/${f.buildId}/截图 space.png`);
  expect((await f.request(encodeURI(path), { content: `![Shot](<${path}>)` })).status).toBe(200);
});
it("rejects browser DNS rebinding and cross-site requests even with the custom header", async () => {
  const f = await setup();
  for (const headers of [{ origin: "http://evil.test", "x-muster-image": "1" }, { "sec-fetch-site": "cross-site", "x-muster-image": "1" }]) {
    const response = await f.app.request(`http://evil.test/api/todos/${f.todoId}/images`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(403);
  }
});
