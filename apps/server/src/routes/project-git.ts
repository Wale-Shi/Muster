import { Hono } from "hono";
import { ProjectGit } from "../resources/project-git.js";
import { StateError } from "../orchestrator/state.js";
import type { AppServices } from "../services.js";
export function projectGitRoutes({ db }: AppServices) {
  const app = new Hono();
  const git = (id: string) => { const row = db.row("SELECT * FROM projects WHERE id=?", id); if (!row) throw new StateError("Project not found", 404); return new ProjectGit(db.project(row)); };
  app.get("/projects/:id/tree", async (c) => c.json({ data: await git(c.req.param("id")).tree(c.req.query("path")) }));
  app.get("/projects/:id/file", async (c) => c.json({ data: await git(c.req.param("id")).file(c.req.query("path") ?? "") }));
  app.get("/projects/:id/branches", async (c) => c.json({ data: await git(c.req.param("id")).branches() }));
  app.get("/projects/:id/commits", async (c) => c.json({ data: await git(c.req.param("id")).commits() }));
  app.get("/projects/:id/commits/:sha", async (c) => c.json({ data: await git(c.req.param("id")).commit(c.req.param("sha")) }));
  return app;
}
