import { useConnections } from "./Connections";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, X } from "lucide-react";
import { CLI_DEFAULT_MODEL, type Agent, type AgentPermissions, type Project, type Skill, type Todo } from "@muster/shared";
import { request } from "../api/client";
import { useI18n } from "../i18n";
import { Avatar, ErrorNotice, Loading, PhaseBadge, Section, SettingRow, Switch } from "../components/ui";
import { RuntimeOptions } from "../components/RuntimeOptions";
import { initialModel, keepReasoning, ModelSelect, ReasoningSelect, reasoningLevels } from "../components/ModelFields";
import { useMachines } from "../api/queries";

type Profile = Agent & { inProgress: Todo[]; workspaces: Project[]; skillCount: number };
const permissionKeys: (keyof AgentPermissions)[] = ["createSkills", "updateSkills"];

export function AgentPage() {
  const { id = "" } = useParams(); const { t, label } = useI18n(); const navigate = useNavigate(); const client = useQueryClient();
  const [copied, setCopied] = useState(false);
  const agent = useQuery({ queryKey: ["agent", id], queryFn: () => request<Profile>(`/agents/${id}`) });
  const connections = useConnections();
  const machines = useMachines();
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => request<Skill[]>("/skills") });
  const save = useMutation({ mutationFn: (value: Partial<Agent>) => request<Agent>(`/agents/${id}`, "PATCH", value), onSuccess: () => { void client.invalidateQueries({ queryKey: ["agent", id] }); void client.invalidateQueries({ queryKey: ["agents"] }); } });
  const remove = useMutation({ mutationFn: () => request(`/agents/${id}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["agents"] }); navigate("/agents"); } });
  if (!agent.data) return <div className="management-page"><header className="page-header"><Link to="/agents">{t("ui.agents")}</Link></header><div className="page-content"><ErrorNotice error={agent.error} />{agent.isPending && <Loading />}</div></div>;
  const a = agent.data; const permissions = { createSkills: false, updateSkills: false, ...a.permissions };
  const defaultSkills = skills.data?.filter((s) => a.defaultSkillIds?.includes(s.id)) ?? [];
  const otherSkills = skills.data?.filter((s) => !a.defaultSkillIds?.includes(s.id)) ?? [];
  const rename = (value: string) => { const name = value.trim(); if (name && name !== a.name) save.mutate({ name }); };
  return (
    <div className="management-page">
      <header className="page-header"><div className="breadcrumb"><Link to="/agents">{t("ui.agents")}</Link><span>/</span><span>{a.name}</span></div></header>
      <div className="page-content">
        <div className="profile-content">
          <section className="profile-hero">
            <div className="profile-identity">
              <Avatar name={a.name} />
              <input key={a.name} className="profile-name" aria-label={t("parity.name")} defaultValue={a.name} readOnly={a.isChief} onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              <div className="profile-meta">
                <span className="badge">{label("runtime", a.runtime)}</span>
                <span className="mono">{a.model}</span>
                <button className="copy-id" title={t("parity.copyId")} onClick={() => { void navigator.clipboard.writeText(a.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? t("parity.copied") : a.id.slice(0, 12)}</button>
              </div>
              <textarea key={a.role} className="profile-duty" rows={1} aria-label={t("field.role")} title={t("parity.dutyHelp")} defaultValue={a.role} onBlur={(e) => { const role = e.target.value.trim(); if (role && role !== a.role) save.mutate({ role }); }} />
            </div>
          </section>
          <ErrorNotice error={save.error || remove.error || skills.error} />
          <>
            {(a.isChief || a.workspaces.length > 0) && <Section title={t("ws.leads")} description={a.isChief ? t("ws.defaultMasterHelp") : undefined}>
              {a.workspaces.length ? a.workspaces.map((w) => <SettingRow key={w.id} label={<Link to={`/w/${w.id}`}>{w.name}</Link>}><span className="mono muted">{w.baseBranch}</span></SettingRow>) : <div className="settings-empty">{t("ws.noLeads")}</div>}
            </Section>}
            <Section className="agent-progress" title={t("parity.inProgress")}>
              {a.inProgress.length ? a.inProgress.map((todo) => <SettingRow key={todo.id} label={<Link to={`/todos/${todo.id}`}>#{todo.number} {todo.title}</Link>}><PhaseBadge phase={todo.phase} /></SettingRow>) : <div className="settings-empty">{t("parity.noWork")}</div>}
            </Section>
            <Section className="agent-configuration" title={t("parity.configuration")} description={t("parity.configurationHelp")}>
              <SettingRow label={t("parity.runtime")}>
                <select value={a.runtime} disabled={save.isPending} onChange={(e) => { const runtime = e.target.value as Agent["runtime"]; save.mutate({ runtime, model: initialModel(machines.data, runtime), reasoning: null }); }}><RuntimeOptions /></select>
              </SettingRow>
              <SettingRow label={t("parity.model")} {...(a.model === CLI_DEFAULT_MODEL ? { help: t("ui.cliDefaultModel") } : {})}><ModelSelect label={t("parity.model")} runtime={a.runtime} value={a.model} onChange={(model) => { if (model !== a.model) save.mutate({ model, reasoning: keepReasoning(machines.data, a.runtime, model, a.reasoning) }); }} /></SettingRow>
              <SettingRow label={t("parity.reasoning")} help={t("parity.reasoningHelp")}><ReasoningSelect label={t("parity.reasoning")} levels={reasoningLevels(machines.data, a.runtime, a.model)} value={a.reasoning} onChange={(reasoning) => { if (reasoning !== a.reasoning) save.mutate({ reasoning }); }} /></SettingRow>
            </Section>
            <Section title={t("parity.defaultSkills")} description={t("parity.defaultSkillsHelp")}>
              <div className="chip-list">
                {defaultSkills.map((s) => <span className="chip" key={s.id}><Link to={`/skills/${s.slug}`}>{s.name}</Link><button aria-label={`${t("parity.remove")} ${s.name}`} disabled={save.isPending} onClick={() => save.mutate({ defaultSkillIds: a.defaultSkillIds?.filter((skillId) => skillId !== s.id) ?? [] })}><X size={12} /></button></span>)}
                {otherSkills.length > 0 ? <select className="chip-add" aria-label={t("parity.selectSkill")} value="" disabled={save.isPending} onChange={(e) => save.mutate({ defaultSkillIds: [...(a.defaultSkillIds ?? []), e.target.value] })}><option value="">{t("parity.selectSkill")}</option>{otherSkills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                  : !defaultSkills.length && <span className="muted">{skills.data?.length ? t("parity.allSkillsAdded") : <>{t("parity.noSkillsYet")} <Link className="link" to="/skills/new">{t("parity.newSkill")}</Link></>}</span>}
              </div>
            </Section>
            <Section title={t("phaseB.connections")} description={t("phaseB.grantHelp")}>
              <div className="chip-list">
                {connections.data?.filter((c) => a.connectionIds?.includes(c.id)).map((c) => <span className="chip" key={c.id}>{c.name}<button aria-label={`${t("parity.remove")} ${c.name}`} disabled={save.isPending} onClick={() => save.mutate({ connectionIds: a.connectionIds?.filter((id) => id !== c.id) ?? [] })}><X size={12} /></button></span>)}
                <select className="chip-add" value="" aria-label={t("phaseB.addConnection")} disabled={save.isPending} onChange={(e) => save.mutate({ connectionIds: [...(a.connectionIds ?? []), e.target.value] })}><option value="">{t("phaseB.addConnection")}</option>{connections.data?.filter((c) => !a.connectionIds?.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                {!connections.data?.length && <Link className="link" to="/connections">{t("phaseB.noConnections")}</Link>}
              </div><ErrorNotice error={connections.error} />
            </Section>
            <Section title={t("parity.permissions")}>
              {permissionKeys.map((key) => <SettingRow key={key} label={t(`parity.${key}`)} help={t(`parity.${key}Help`)}><Switch label={t(`parity.${key}`)} checked={permissions[key]} disabled={save.isPending} onChange={(checked) => save.mutate({ permissions: { ...permissions, [key]: checked } })} /></SettingRow>)}
            </Section>
            {!a.isChief && <Section title={t("parity.danger")}>
              <SettingRow label={<span className="danger-text">{t("parity.deleteAgent")}</span>} help={t("parity.deleteAgentHelp")}><button className="button danger" aria-label={t("parity.deleteAgent")} disabled={remove.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) remove.mutate(); }}><Trash2 size={14} />{t("parity.delete")}</button></SettingRow>
            </Section>}
          </>
        </div>
      </div>
    </div>
  );
}

