import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, Lock, Plus, Trash2 } from "lucide-react";
import type { Secret, Message } from "@muster/shared";
import { request } from "../api/client";
import { useProjects } from "../api/queries";
import { useI18n } from "../i18n";
import { Dialog, ErrorNotice, Section, SettingRow } from "../components/ui";

type SecretInput = { name: string; scope: "team" | "project"; projectId?: string };
export function SecretForm({ input, requestId, onSaved, onCancel }: { input: SecretInput; requestId?: string; onSaved: () => void; onCancel?: () => void }) {
  const { t } = useI18n(); const client = useQueryClient(); const [name, setName] = useState(input.name); const [value, setValue] = useState(""); const [show, setShow] = useState(false);
  const save = useMutation({ mutationFn: () => request("/secrets", "PUT", { ...input, name, value, ...(requestId ? { requestId } : {}) }), onSuccess: () => { setValue(""); void client.invalidateQueries({ queryKey: ["secrets"] }); void client.invalidateQueries({ queryKey: ["messages"] }); onSaved(); } });
  return (
    <form className="form-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <label>{t("parity.name")}<input className="mono" required pattern="[A-Z_][A-Z0-9_]{0,63}" title={t("parity.secretNameHelp")} placeholder="API_TOKEN" value={name} readOnly={!!input.name} autoFocus={!input.name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} /></label>
      <label>{t("parity.value")}
        <span className="input-with-action">
          <input required type={show ? "text" : "password"} value={value} autoComplete="new-password" spellCheck={false} autoFocus={!!input.name} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="icon-button" aria-label={t("parity.show")} aria-pressed={show} onClick={() => setShow(!show)}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </span>
      </label>
      <span className="hint"><Lock size={12} /> {t("parity.writeOnly")}</span>
      <ErrorNotice error={save.error} />
      <div className="row dialog-actions">{onCancel && <button type="button" className="button ghost" onClick={onCancel}>{t("parity.cancel")}</button>}<button className="button primary" disabled={save.isPending || !value || !name}>{t("parity.save")}</button></div>
    </form>
  );
}
export function SecretCard({ message }: { message: Message }) {
  const { t } = useI18n(); const [saved, setSaved] = useState(false); const input = message.meta.secretRequest as SecretInput & { reason: string };
  return (
    <div className="secret-card">
      <Section title={`${t("parity.secureInput")} · ${input.name}`} description={input.reason}>
        {saved || message.meta.fulfilledAt ? <p role="status" className="hint"><Lock size={12} /> {t("parity.secretSaved")}</p> : <><p className="hint">{t("parity.secureHelp")}</p><SecretForm input={input} requestId={message.id} onSaved={() => setSaved(true)} /></>}
      </Section>
    </div>
  );
}
export function SecretsPage() {
  const { t, formatRelative } = useI18n(); const projects = useProjects(); const client = useQueryClient(); const [editing, setEditing] = useState<SecretInput | null>(null);
  const secrets = useQuery({ queryKey: ["secrets"], queryFn: () => request<Secret[]>("/secrets") });
  const remove = useMutation({ mutationFn: (id: string) => request(`/secrets/${id}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["secrets"] }); } });
  const groups: { title: string; description: string; input: SecretInput }[] = [
    { title: t("parity.team"), description: t("parity.teamSecretsHelp"), input: { scope: "team", name: "" } },
    ...(projects.data ?? []).map((p) => ({ title: p.name, description: t("parity.projectSecretsHelp"), input: { scope: "project" as const, projectId: p.id, name: "" } })),
  ];
  return (
    <div className="management-page">
      <header className="page-header"><h1>{t("parity.secrets")}</h1><button className="button primary" onClick={() => setEditing({ scope: "team", name: "" })}><Plus size={14} />{t("parity.addSecret")}</button></header>
      <div className="page-content">
        <div className="profile-content">

          <ErrorNotice error={secrets.error || projects.error || remove.error} />
          {groups.map(({ title, description, input }) => {
            const items = secrets.data?.filter((s) => s.scope === input.scope && s.projectId === (input.projectId ?? null)) ?? [];
            return (
              <Section key={input.projectId ?? "team"} title={title} description={description} actions={<button className="button ghost sm" onClick={() => setEditing(input)}><Plus size={14} />{t("parity.add")}</button>}>
                {!items.length ? <div className="settings-empty">{t("parity.secretEmpty")}</div> : items.map((s) => (
                  <SettingRow key={s.id} label={<><KeyRound size={13} className="muted" /><span className="mono">{s.name}</span></>} help={t("parity.updatedAgo", { time: formatRelative(s.updatedAt) })}>
                    <button className="button ghost sm" onClick={() => setEditing({ ...input, name: s.name })}>{t("parity.replace")}</button>
                    <button className="icon-button" aria-label={`${t("parity.delete")} ${s.name}`} disabled={remove.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) remove.mutate(s.id); }}><Trash2 size={14} /></button>
                  </SettingRow>
                ))}
              </Section>
            );
          })}
          {editing && <Dialog title={editing.name ? `${t("parity.replace")} · ${editing.name}` : t("parity.addSecret")} onClose={() => setEditing(null)}>
            <div className="dialog-body">
              {!editing.name && (projects.data?.length ?? 0) > 0 && <label>{t("parity.scope")}<select value={editing.projectId ?? ""} onChange={(e) => setEditing(e.target.value ? { scope: "project", projectId: e.target.value, name: "" } : { scope: "team", name: "" })}><option value="">{t("parity.team")}</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
              <SecretForm key={`${editing.scope}:${editing.projectId ?? ""}`} input={editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
            </div>
          </Dialog>}
        </div>
      </div>
    </div>
  );
}
