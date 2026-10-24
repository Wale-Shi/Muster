import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiKey, WorkspaceSettings } from "@muster/shared";
import { request } from "../api/client";
import { languageNames, useI18n } from "../i18n";
import { useTheme } from "../hooks/usePreferences";
import { Dialog, ErrorNotice, Section, Segmented, SettingRow, Switch } from "../components/ui";
import { shortcuts } from "../lib/shortcuts";

export function useWorkspaceSettings() { return useQuery({ queryKey: ["settings"], queryFn: () => request<WorkspaceSettings>("/settings") }); }
export function CopyButton({ value }: { value: string }) {
  const { t } = useI18n(); const [copied, setCopied] = useState(false); const [error, setError] = useState<unknown>(null);
  return <><button type="button" className="button ghost sm" onClick={() => { void navigator.clipboard.writeText(value).then(() => setCopied(true), setError); }}>{t(copied ? "phaseC.copied" : "phaseC.copy")}</button><ErrorNotice error={error} /></>;
}
export function ShortcutsList() { const { t } = useI18n(); return <Section title={t("phaseC.shortcuts")}>{shortcuts.map((s) => <SettingRow key={s.keys} label={t(s.label)}><kbd>{s.keys}</kbd></SettingRow>)}</Section>; }
export function ShortcutsDialog({ onClose }: { onClose: () => void }) { const { t } = useI18n(); return <Dialog title={t("phaseC.shortcuts")} onClose={onClose}><div className="dialog-body"><ShortcutsList /></div></Dialog>; }
export function clientSnippets(origin: string) {
  const url = `${origin}/api/mcp`;
  return [
    { name: "Claude Code", content: `claude mcp add --transport http muster ${url} --header "Authorization: Bearer <key>"` },
    { name: "Codex · ~/.codex/config.toml", content: `[mcp_servers.muster]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer <key>" }` },
    { name: "Cursor / JSON", content: JSON.stringify({ mcpServers: { muster: { url, headers: { Authorization: "Bearer <key>" } } } }, null, 2) },
  ];
}
export function SettingsPage() {
  const { t, locale, setLocale, formatDate } = useI18n(); const { theme, setTheme } = useTheme(); const client = useQueryClient(); const settings = useWorkspaceSettings();
  const [tab, setTab] = useState<"general" | "notifications" | "apiKeys" | "mcp" | "shortcuts">("general");
  const [showCreate, setShowCreate] = useState(false); const [fullKey, setFullKey] = useState<string | null>(null);
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => request<ApiKey[]>("/api-keys") });
  const save = useMutation({ mutationFn: (patch: Partial<WorkspaceSettings>) => request<WorkspaceSettings>("/settings", "PATCH", patch), onSuccess: (data) => client.setQueryData(["settings"], data) });
  const revoke = useMutation({ mutationFn: (id: string) => request(`/api-keys/${id}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["api-keys"] }); } });
  const s = settings.data;
  return <div className="management-page"><header className="page-header"><h1>{t("phaseC.settings")}</h1></header><div className="page-content"><div className="profile-content">
    <div className="page-intro"><h2>{t("phaseC.settings")}</h2><p>{t("phaseC.settingsIntro")}</p></div>
    <Segmented label={t("phaseC.settings")} value={tab} onChange={setTab} options={(["general", "notifications", "apiKeys", "mcp", "shortcuts"] as const).map((value) => ({ value, label: t(`phaseC.${value}`) }))} />
    <ErrorNotice error={settings.error || save.error || revoke.error} />
    {tab === "general" && s && <Section title={t("phaseC.general")}>
      <SettingRow label={t("phaseC.workspaceName")}><form className="input-with-action" onSubmit={(e) => { e.preventDefault(); save.mutate({ workspaceName: String(new FormData(e.currentTarget).get("name")) }); }}><input name="name" aria-label={t("phaseC.workspaceName")} required maxLength={100} defaultValue={s.workspaceName} /><button className="button ghost sm" disabled={save.isPending}>{t("parity.save")}</button></form></SettingRow>
      {/* Language and appearance are per-device preferences, not workspace settings. */}
      <SettingRow label={t("text.language")} help={t("phaseC.deviceOnly")}><select aria-label={t("text.language")} value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)}>{Object.entries(languageNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></SettingRow>
      <SettingRow label={t("ui.appearance")} help={t("phaseC.deviceOnly")}><Segmented label={t("ui.appearance")} value={theme} onChange={setTheme} options={(["light", "dark", "system"] as const).map((value) => ({ value, label: t(`theme.${value}`) }))} /></SettingRow>
    </Section>}
    {tab === "notifications" && s && <Section title={t("phaseC.notifications")} description={!window.muster?.desktop ? t("phaseC.desktopOnly") : undefined}>{(["confirm", "review", "failed", "done", "dockBadge"] as const).map((key) => <SettingRow key={key} label={t(`phaseC.${key}`)}><Switch label={t(`phaseC.${key}`)} checked={s.notifications[key]} disabled={save.isPending} onChange={(checked) => save.mutate({ notifications: { ...s.notifications, [key]: checked } })} /></SettingRow>)}</Section>}
    {tab === "apiKeys" && <Section title={t("phaseC.apiKeys")} actions={<button className="button primary" onClick={() => setShowCreate(true)}>{t("phaseC.createKey")}</button>}><ErrorNotice error={keys.error} />{!keys.data?.length && <div className="settings-empty">{t("phaseC.noKeys")}</div>}{keys.data?.map((key) => <SettingRow key={key.id} label={key.name} help={`${key.prefix}… · ${key.scopes.join(", ")} · ${t("phaseC.created")}: ${formatDate(key.createdAt)} · ${t("phaseC.lastUsed")}: ${key.lastUsedAt ? formatDate(key.lastUsedAt) : t("phaseC.never")}`}>{key.revokedAt ? <span className="muted">{t("phaseC.revoked")}</span> : <button className="button danger" aria-label={`${t("phaseC.revoke")} ${key.name}`} disabled={revoke.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) revoke.mutate(key.id); }}>{t("phaseC.revoke")}</button>}</SettingRow>)}</Section>}
    {tab === "mcp" && <><p>{t("phaseC.mcpIntro")}</p><span className={`status-dot ${keys.data?.some((k) => !k.revokedAt) ? "ok" : ""}`}>{t(keys.data?.some((k) => !k.revokedAt) ? "phaseC.mcpReady" : "phaseC.mcpMissing")}</span><Section title={t("phaseC.stepKey")}><SettingRow label={t("phaseC.apiKeys")}><button className="button" onClick={() => setShowCreate(true)}>{t("phaseC.createKey")}</button></SettingRow></Section><Section title={t("phaseC.stepEndpoint")}><SettingRow label={<code>{location.origin}/api/mcp</code>}><CopyButton value={`${location.origin}/api/mcp`} /></SettingRow></Section><Section title={t("phaseC.stepClient")} description={t("phaseC.keyPlaceholder")}>{clientSnippets(location.origin).map((snippet) => <div className="settings-snippet" key={snippet.name}><div className="row"><strong>{snippet.name}</strong><CopyButton value={snippet.content} /></div><pre>{snippet.content}</pre></div>)}</Section><p className="hint">{t("phaseC.cliVersions")}</p></>}
    {tab === "shortcuts" && <ShortcutsList />}
    {showCreate && <CreateKey onClose={() => setShowCreate(false)} onCreated={(key) => { setShowCreate(false); setFullKey(key); void client.invalidateQueries({ queryKey: ["api-keys"] }); }} />}
    {fullKey && <Dialog title={t("phaseC.apiKeys")} onClose={() => setFullKey(null)}><div className="dialog-body form-stack"><p>{t("phaseC.keyOnce")}</p><code className="key-value">{fullKey}</code><CopyButton value={fullKey} /></div></Dialog>}
  </div></div></div>;
}
function CreateKey({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { t } = useI18n(); const [name, setName] = useState(""); const [scope, setScope] = useState<"chief" | "read">("read");
  const save = useMutation({ mutationFn: () => request<ApiKey & { key: string }>("/api-keys", "POST", { name, scopes: [scope] }), onSuccess: (data) => onCreated(data.key) });
  return <Dialog title={t("phaseC.createKey")} onClose={onClose}><form className="dialog-body form-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}><label>{t("parity.name")}<input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label><label>{t("phaseC.scope")}<select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>{(["read", "chief"] as const).map((value) => <option key={value} value={value}>{t(`phaseC.${value}`)}</option>)}</select></label><ErrorNotice error={save.error} /><button className="button primary" disabled={save.isPending || !name.trim()}>{t("phaseC.createKey")}</button></form></Dialog>;
}
