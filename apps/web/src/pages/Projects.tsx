import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitBranch, Plus } from "lucide-react";
import { api } from "../api/client";
import { useProjects, useTodos } from "../api/queries";
import { Dialog, Empty, ErrorNotice, Loading } from "../components/ui";

export function Projects() {
  const projects = useProjects();
  const todos = useTodos();
  const [open, setOpen] = useState(false);
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>Projects</h1>
        <button className="button primary" onClick={() => setOpen(true)}>
          <Plus size={14} />
          New project
        </button>
      </header>
      <div className="page-content">
        <div className="page-intro">
          <h2>A home for every task.</h2>
          <p>Connect a repository. Your agents work in isolated branches.</p>
        </div>
        <ErrorNotice error={projects.error || todos.error} />
        {projects.isPending ? (
          <Loading />
        ) : !projects.data?.length ? (
          <Empty
            icon={<FolderGit2 size={26} />}
            title="Your next project starts here"
          >
            <button className="button" onClick={() => setOpen(true)}>
              Connect a repository
            </button>
          </Empty>
        ) : (
          <div className="project-list">
            {projects.data.map((project) => (
              <article className="project-row" key={project.id}>
                <span className="project-icon">
                  <FolderGit2 size={20} />
                </span>
                <div className="project-info">
                  <h3>{project.name}</h3>
                  <p className="mono muted" title={project.repoUrl}>
                    {project.repoUrl}
                  </p>
                </div>
                <span className="badge mono">
                  <GitBranch size={12} />
                  {project.baseBranch}
                </span>
                <span className="muted">
                  {todos.data?.filter(
                    (todo) =>
                      todo.projectId === project.id && todo.phase !== "closed",
                  ).length ?? 0}{" "}
                  tasks
                </span>
              </article>
            ))}
          </div>
        )}
      </div>
      {open && <ProjectDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
function ProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        baseBranch: baseBranch.trim(),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <label>
            Name
            <input
              autoFocus
              required
              placeholder="My project"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Repository path or URL
            <input
              required
              className="mono"
              placeholder="/path/to/repo or https://github.com/…"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
            />
          </label>
          <p className="hint">
            Local paths must be accessible on the machine running the agent.
          </p>
          <label>
            Base branch
            <input
              required
              className="mono"
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
            />
          </label>
          <ErrorNotice error={create.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={
              create.isPending ||
              !name.trim() ||
              !repoUrl.trim() ||
              !baseBranch.trim()
            }
          >
            {create.isPending ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
