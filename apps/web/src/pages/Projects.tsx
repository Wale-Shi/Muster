import { Link } from "react-router";
import { useI18n } from "../i18n";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitBranch, Plus } from "lucide-react";
import { api } from "../api/client";
import { useProjects, useTodos } from "../api/queries";
import { Dialog, Empty, ErrorNotice, Loading } from "../components/ui";

export function Projects() {
  const { t } = useI18n();
  const projects = useProjects();
  const todos = useTodos();
  const [open, setOpen] = useState(false);
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>{t("ui.projects")}</h1>
        <button className="button primary" onClick={() => setOpen(true)}>
          <Plus size={14} />
          {t("ui.newProject")}
        </button>
      </header>
      <div className="page-content">
        <ErrorNotice error={projects.error || todos.error} />
        {projects.isPending ? (
          <Loading />
        ) : !projects.data?.length ? (
          <Empty
            icon={<FolderGit2 size={26} />}
            title={t("ui.yourNextProjectStartsHere")}
          >
            <button className="button" onClick={() => setOpen(true)}>
              {t("ui.connectARepository")}
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
                  <h3><Link to={`/projects/${project.id}`}>{project.name}</Link></h3>
                  <p className="mono muted" title={project.repoUrl}>
                    {project.repoUrl}
                  </p>
                </div>
                <span className="badge mono">
                  <GitBranch size={12} />
                  {project.baseBranch}
                </span>
                <span className="muted">
                  {t("count.tasks", { count: todos.data?.filter((todo) => todo.projectId === project.id && todo.phase !== "closed").length ?? 0 })}
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
export function ProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [folderError, setFolderError] = useState<unknown>(null);
  const chooseFolder = async () => {
    try { const path = await window.muster?.chooseFolder(); if (path) setRepoUrl(path); }
    catch (error) { setFolderError(error); }
  };
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
    <Dialog title={t("ui.newProject")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <label>
            {t("ui.name")}<input
              autoFocus
              required
              placeholder={t("ui.myProject")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("ui.repositoryPathOrURL")}<input
              required
              className="mono"
              placeholder={t("ui.pathtorepoOrHttpsgithubcom")}
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
            />
          </label>
          {window.muster?.desktop && <button type="button" className="button" onClick={() => { void chooseFolder(); }}>{t("ui.chooseFolder")}
          </button>}
          <ErrorNotice error={folderError} />
          <p className="hint">
            {t("ui.localPathsMustBeAccessibleOnTheMachineRunningTheAgent")}
          </p>
          <label>
            {t("ui.baseBranch")}<input
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
            {t("ui.cancel")}
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
            {create.isPending ? t("ui.creating") : t("ui.createProject")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
