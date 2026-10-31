import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plug } from "lucide-react";
import type { Agent } from "@muster/shared";
import { api } from "../api/client";
import { useAgents, useProject } from "../api/queries";
import { useI18n } from "../i18n";
import { Dialog, Empty, ErrorNotice, Loading, Section, SettingRow } from "../components/ui";
import { clientSnippets, CopyButton } from "./Settings";

/** Choose a workspace's master agent; empty means the default master agent. */
function MasterSelect({ agents, value, onChange, disabled }: { agents: Agent[]; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { t, label } = useI18n();
  const fallback = agents.find((agent) => agent.isChief);
  return (
    <select aria-label={t("ws.master")} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t("ws.defaultMasterOption", { name: fallback?.name ?? "Chief" })}</option>
      {agents.filter((agent) => !agent.isChief).map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {label("runtime", agent.runtime)}</option>)}
    </select>
  );
}

export function WorkspaceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const agents = useAgents();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [master, setMaster] = useState("");
  const [folderError, setFolderError] = useState<unknown>(null);
  const chooseFolder = async () => {
    try { const path = await window.muster?.chooseFolder(); if (path) setRepoUrl(path); }
    catch (error) { setFolderError(error); }
  };
  const client = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), repoUrl: repoUrl.trim(), baseBranch: baseBranch.trim(), chiefAgentId: master || null }),
    onSuccess: (workspace) => {
      void client.invalidateQueries({ queryKey: ["projects"] });
      onClose();
      void navigate(`/w/${workspace.id}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Dialog title={t("ws.new")} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-body form-stack">
          <label>
            {t("ui.name")}<input autoFocus required placeholder={t("ws.namePlaceholder")} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("ui.repositoryPathOrURL")}<input required className="mono" placeholder={t("ui.pathtorepoOrHttpsgithubcom")} value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} />
          </label>
          {window.muster?.desktop && <button type="button" className="button" onClick={() => { void chooseFolder(); }}>{t("ui.chooseFolder")}</button>}
          <ErrorNotice error={folderError} />
          <p className="hint">{t("ui.localPathsMustBeAccessibleOnTheMachineRunningTheAgent")}</p>
          <label>
            {t("ui.baseBranch")}<input required className="mono" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
          </label>
          <label>
            {t("ws.master")}<MasterSelect agents={agents.data ?? []} value={master} onChange={setMaster} />
          </label>
          <p className="hint">{t("ws.masterHelp")}</p>
          <ErrorNotice error={create.error || agents.error} />
        </div>
        <div className="dialog-footer">
          <button type="button" className="button" onClick={onClose}>{t("ui.cancel")}</button>
          <button className="button primary" disabled={create.isPending || !name.trim() || !repoUrl.trim() || !baseBranch.trim()}>
            {create.isPending ? t("ui.creating") : t("ws.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function WorkspaceEmpty({ error }: { error?: unknown }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="page-content">
      <ErrorNotice error={error} />
      <Empty icon={<FolderGit2 size={26} />} title={t("ws.emptyTitle")}>
        <p className="muted">{t("ws.emptyHelp")}</p>
        <button className="button primary" onClick={() => setOpen(true)}>{t("ws.new")}</button>
      </Empty>
      {open && <WorkspaceDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

export function WorkspaceSettingsPage() {
  const { id = "" } = useParams(); const { t, formatDate } = useI18n();
  const project = useProject(id); const agents = useAgents();
  const client = useQueryClient(); const navigate = useNavigate();
  const save = useMutation({ mutationFn: (input: Parameters<typeof api.updateProject>[1]) => api.updateProject(id, input), onSuccess: () => { void client.invalidateQueries({ queryKey: ["projects"] }); } });
  const remove = useMutation({ mutationFn: () => api.deleteProject(id), onSuccess: () => { void client.invalidateQueries({ queryKey: ["projects"] }); void navigate("/"); } });
  const p = project.data;
  const endpoint = `${location.origin}/api/mcp/workspaces/${id}`;
  return (
    <div className="management-page">
      <header className="page-header"><div className="breadcrumb"><Link to={`/w/${id}`}>{p?.name ?? t("ws.workspace")}</Link><span>/</span><h1>{t("ws.settings")}</h1></div></header>
      <div className="page-content"><div className="profile-content">
        <ErrorNotice error={project.error || save.error || remove.error || agents.error} />
        {!p ? <Loading /> : <>
          <form className="form-stack" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); save.mutate({ name: String(data.get("name")), baseBranch: String(data.get("baseBranch")), description: String(data.get("description")) }); }}>
            <Section title={t("parity.details")}>
              <SettingRow label={t("parity.name")}><input aria-label={t("parity.name")} name="name" required defaultValue={p.name} /></SettingRow>
              <SettingRow label={t("ui.baseBranch")}><input aria-label={t("ui.baseBranch")} className="mono" name="baseBranch" required defaultValue={p.baseBranch} /></SettingRow>
              <SettingRow label={t("parity.description")} help={t("ws.descriptionHelp")}><textarea aria-label={t("parity.description")} name="description" rows={3} maxLength={16000} defaultValue={p.description} /></SettingRow>
              <SettingRow label={t("ui.repositoryPathOrURL")}><span className="key-value mono">{p.repoUrl}</span><CopyButton value={p.repoUrl} /></SettingRow>
              <SettingRow label={t("phaseC.created")}>{formatDate(p.createdAt)}</SettingRow>
            </Section>
            <button className="button primary" disabled={save.isPending}>{t("parity.save")}</button>
          </form>
          <Section title={t("ws.master")} description={t("ws.masterHelp")}>
            <SettingRow label={t("ws.master")}><MasterSelect agents={agents.data ?? []} value={p.chiefAgentId ?? ""} disabled={save.isPending} onChange={(value) => save.mutate({ chiefAgentId: value || null })} /></SettingRow>
          </Section>
          <Section title={t("ws.mcpTitle")} description={t("ws.mcpHelp")}>
            <SettingRow label={<code>{endpoint}</code>}><CopyButton value={endpoint} /></SettingRow>
            {clientSnippets(endpoint, `muster-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace"}`).map((snippet) => <div className="settings-snippet" key={snippet.name}><div className="row"><strong>{snippet.name}</strong><CopyButton value={snippet.content} /></div><pre>{snippet.content}</pre></div>)}
            <SettingRow label={t("ws.mcpKey")} help={t("ws.mcpKeyHelp")}><Link className="button" to="/settings?tab=apiKeys"><Plug size={14} />{t("phaseC.apiKeys")}</Link></SettingRow>
          </Section>
          <Section title={t("parity.danger")}>
            <SettingRow label={t("ws.delete")} help={t("ws.deleteHelp")}><button className="button danger" aria-label={t("ws.delete")} disabled={remove.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) remove.mutate(); }}>{t("parity.delete")}</button></SettingRow>
          </Section>
        </>}
      </div></div>
    </div>
  );
}
