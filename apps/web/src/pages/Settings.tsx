import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiKey, WorkspaceSettings } from "@muster/shared";
import { request } from "../api/client";
import { useProjects } from "../api/queries";
import { useI18n } from "../i18n";
import { useTheme } from "../hooks/usePreferences";
import { Dialog, ErrorNotice, Section, Segmented, SettingRow, Switch } from "../components/ui";

export function useWorkspaceSettings() { return useQuery({ queryKey: ["settings"], queryFn: () => request<WorkspaceSettings>("/settings") }); }
export function CopyButton({ value }: { value: string }) {
  const { t } = useI18n(); const [copied, setCopied] = useState(false); const [error, setError] = useState<unknown>(null);
  return <><button type="button" className="button ghost sm" onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true), setError); }}>{t(copied ? "phaseC.copied" : "phaseC.copy")}</button><ErrorNotice error={error} /></>;
}
/** Client configuration for an MCP endpoint, with `<key>` left for the user's API key. */
export function clientSnippets(url: string, name = "muster") {
  return [
    { name: "Claude Code", content: `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer <key>"` },
    { name: "Codex · ~/.codex/config.toml", content: `[mcp_servers.${name.replaceAll("-", "_")}]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer <key>" }` },
    { name: "Cursor / JSON", content: JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: "Bearer <key>" } } } }, null, 2) },
  ];
}
const tabs = ["general", "notifications", "apiKeys", "mcp"] as const;
type Tab = typeof tabs[number];
export function SettingsPage() {
  const { t, formatDate } = useI18n(); const { theme, setTheme } = useTheme(); const client = useQueryClient(); const settings = useWorkspaceSettings(); const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: Tab = tabs.find((value) => value === requested) ?? "general";
  const setTab = (value: Tab) => setParams({ tab: value });
  const [showCreate, setShowCreate] = useState(false); const [fullKey, setFullKey] = useState<string | null>(null);
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => request<ApiKey[]>("/api-keys") });
  const save = useMutation({ mutationFn: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>("/settings", "PATCH", patch), onSuccess: (data) => client.setQueryData(["settings"], data) });
  const revoke = useMutation({ mutationFn: (id: string) => request(`/api-keys/${id}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["api-keys"] }); } });
  const s = settings.data;
  const ready = keys.data?.some((k) => !k.revokedAt);
  return <div className="management-page"><header className="page-header"><h1>{t("phaseC.settings")}</h1></header><div className="page-content"><div className="settings-layout">
    <nav className="settings-nav" aria-label={t("phaseC.settings")} role="tablist">
      {tabs.map((value) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)}>{t(`phaseC.${value}`)}</button>)}
    </nav><div className="settings-content">
    <ErrorNotice error={settings.error || save.error || revoke.error} />
    {tab === "general" && s && <Section title={t("phaseC.general")}>
      <SettingRow label={t("phaseC.workspaceName")}><form className="input-with-action" onSubmit={(e) => { e.preventDefault(); save.mutate({ workspaceName: String(new FormData(e.currentTarget).get("name")) }); }}><input name="name" aria-label={t("phaseC.workspaceName")} required maxLength={100} defaultValue={s.workspaceName} /><button className="button ghost sm" disabled={save.isPending}>{t("parity.save")}</button></form></SettingRow>
      {/* Appearance is a per-device preference, not a server setting. */}
      <SettingRow label={t("ui.appearance")} help={t("phaseC.deviceOnly")}><Segmented label={t("ui.appearance")} value={theme} onChange={setTheme} options={(["light", "dark", "system"] as const).map((value) => ({ value, label: t(`theme.${value}`) }))} /></SettingRow>
    </Section>}
    {tab === "notifications" && s && <Section title={t("phaseC.notifications")} description={!window.muster?.desktop ? t("phaseC.desktopOnly") : undefined}>{(["review", "failed", "done", "dockBadge"] as const).map((key) => <SettingRow key={key} label={t(`phaseC.${key}`)}><Switch label={t(`phaseC.${key}`)} checked={s.notifications[key]} disabled={save.isPending} onChange={(checked) => save.mutate({ notifications: { ...s.notifications, [key]: checked } })} /></SettingRow>)}</Section>}
    {tab === "apiKeys" && <Section title={t("phaseC.apiKeys")} actions={<button className="button primary" onClick={() => setShowCreate(true)}>{t("phaseC.createKey")}</button>}><ErrorNotice error={keys.error} />{!keys.data?.length && <div className="settings-empty">{t("phaseC.noKeys")}</div>}{keys.data?.map((key) => <SettingRow key={key.id} label={key.name} help={`${key.prefix}… · ${key.scopes.join(", ")} · ${t("phaseC.created")}: ${formatDate(key.createdAt)} · ${t("phaseC.lastUsed")}: ${key.lastUsedAt ? formatDate(key.lastUsedAt) : t("phaseC.never")}`}>{key.revokedAt ? <span className="muted">{t("phaseC.revoked")}</span> : <button className="button danger" aria-label={`${t("phaseC.revoke")} ${key.name}`} disabled={revoke.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) revoke.mutate(key.id); }}>{t("phaseC.revoke")}</button>}</SettingRow>)}</Section>}
    {tab === "mcp" && <>
      <p>{t("ws.mcpIntro")}</p>
      <span className={`status-dot ${ready ? "ok" : ""}`}>{t(ready ? "phaseC.mcpReady" : "phaseC.mcpMissing")}</span>
      <Section title={t("phaseC.stepKey")}><SettingRow label={t("phaseC.apiKeys")}><button className="button" onClick={() => setShowCreate(true)}>{t("phaseC.createKey")}</button></SettingRow></Section>
      <Section title={t("ws.mcpEndpoints")} description={t("ws.mcpEndpointsHelp")}>
        <SettingRow label={<code>{location.origin}/api/mcp</code>} help={t("ws.mcpAll")}><CopyButton value={`${location.origin}/api/mcp`} /></SettingRow>
        {projects.data?.map((project) => <SettingRow key={project.id} label={<code>{location.origin}/api/mcp/workspaces/{project.id}</code>} help={<Link to={`/w/${project.id}/settings`}>{project.name}</Link>}><CopyButton value={`${location.origin}/api/mcp/workspaces/${project.id}`} /></SettingRow>)}
      </Section>
      <Section title={t("phaseC.stepClient")} description={t("phaseC.keyPlaceholder")}>{clientSnippets(`${location.origin}/api/mcp`).map((snippet) => <div className="settings-snippet" key={snippet.name}><div className="row"><strong>{snippet.name}</strong><CopyButton value={snippet.content} /></div><pre>{snippet.content}</pre></div>)}</Section>
      <Section title={t("ws.mcpTools")}>{(["assign_work", "create_task", "get_workspace", "get_task_log", "complete_task"] as const).map((tool) => <SettingRow key={tool} label={<code>{tool}</code>} help={t(`ws.tool_${tool}`)}>{null}</SettingRow>)}</Section>
    </>}
    {showCreate && <CreateKey onClose={() => setShowCreate(false)} onCreated={(key) => { setShowCreate(false); setFullKey(key); void client.invalidateQueries({ queryKey: ["api-keys"] }); }} />}
    {fullKey && <Dialog title={t("phaseC.apiKeys")} onClose={() => setFullKey(null)}><div className="dialog-body form-stack"><p>{t("phaseC.keyOnce")}</p><code className="key-value">{fullKey}</code><CopyButton value={fullKey} /></div></Dialog>}
  </div></div></div></div>;
}
function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { t } = useI18n(); const [name, setName] = useState(""); const [scope, setScope] = useState<"chief" | "read">("chief");
  const save = useMutation({ mutationFn: () => request<ApiKey & { key: string }>("/api-keys", "POST", { name, scopes: [scope] }), onSuccess: (data) => onCreated(data.key) });
  return <Dialog title={t("phaseC.createKey")} onClose={onClose}><form className="dialog-body form-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}><label>{t("parity.name")}<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label><label>{t("phaseC.scope")}<select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>{(["chief", "read"] as const).map((value) => <option key={value} value={value}>{t(`phaseC.${value}`)}</option>)}</select></label><ErrorNotice error={save.error} /><button className="button primary" disabled={save.isPending || !name.trim()}>{t("phaseC.createKey")}</button></form></Dialog>;
}
