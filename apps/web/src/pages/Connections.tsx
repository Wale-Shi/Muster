import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { connectionCatalog, connectionSchema, type CatalogEntry, type Connection, type ConnectionInput } from "@muster/shared";
import { request } from "../api/client";
import { useMachines } from "../api/queries";
import { useI18n } from "../i18n";
import { Dialog, Empty, ErrorNotice, Loading, Section, Segmented, SettingRow, Switch } from "../components/ui";
// Suggested identifier for a connection name; it becomes the tool prefix mcp__<identifier>__.
const slug = (name: string) => { const value = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 32); return value.length > 1 ? value : ""; };
export const useConnections = () => useQuery({ queryKey: ["connections"], queryFn: () => request<Connection[]>("/connections") });

export function ConnectionForm({ entry, connection, onSaved, onCancel }: { entry?: CatalogEntry; connection?: Connection; onSaved: () => void; onCancel: () => void }) {
  const { t } = useI18n(); const client = useQueryClient(); const machines = useMachines();
  const [transport, setTransport] = useState<"http" | "stdio">(connection?.transport ?? entry?.transport ?? "http");
  const [name, setName] = useState(connection?.name ?? entry?.name ?? ""); const [identifier, setIdentifier] = useState(connection?.identifier ?? entry?.id ?? "");
  const [url, setUrl] = useState(connection?.url ?? entry?.url ?? ""); const [command, setCommand] = useState(connection?.command ?? entry?.command ?? "");
  const [args, setArgs] = useState((connection?.args ?? entry?.args ?? []).join("\n")); const [machineId, setMachine] = useState(connection?.machineId ?? "");
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [token, setToken] = useState(""); const [values, setValues] = useState<{ key: string; value: string }[]>([]);
  const input: ConnectionInput = { name, identifier, transport, url: transport === "http" ? url : null, command: transport === "stdio" ? command : null, args: args ? args.split("\n") : [], machineId: transport === "stdio" ? machineId || null : null, catalogId: entry?.id ?? connection?.catalogId ?? null,
    ...(entry?.auth.kind === "header" && token ? { secrets: { [entry.auth.header]: entry.auth.format.replace("{token}", token) } } : entry?.auth.kind === "env" && token ? { secrets: { [entry.auth.name]: token } } : values.length || replaceCredentials ? { secrets: Object.fromEntries(values.map((v) => [v.key, v.value])) } : {}) };
  const valid = connectionSchema.safeParse(input).success && new Set(values.map((v) => v.key)).size === values.length && (!entry || !["header", "env"].includes(entry.auth.kind) || !!connection || !!token);
  const save = useMutation({ mutationFn: () => request(`/connections${connection ? `/${connection.id}` : ""}`, connection ? "PATCH" : "POST", input), onSuccess: () => { setToken(""); setValues([]); void client.invalidateQueries({ queryKey: ["connections"] }); onSaved(); } });
  return <form className="form-stack" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
    {!entry && <><Segmented label={t("phaseB.transport")} value={transport} onChange={setTransport} options={[{ value: "http", label: t("phaseB.http") }, { value: "stdio", label: t("phaseB.stdio") }]} />
      <label>{t("parity.name")}<input required value={name} onChange={(e) => { const next = e.target.value; if (!connection && identifier === slug(name)) setIdentifier(slug(next)); setName(next); }} /></label>
      <label>{t("phaseB.identifier")}<input required pattern="[a-z][a-z0-9_]{1,31}" readOnly={!!connection} value={identifier} onChange={(e) => setIdentifier(e.target.value)} /><span className="hint">{t("phaseB.identifierHelp", { identifier: identifier || "example" })}</span></label>
      {transport === "http" ? <label>{t("phaseB.url")}<input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} /></label> : <><label>{t("phaseB.command")}<input required value={command} onChange={(e) => setCommand(e.target.value)} /></label><label>{t("phaseB.args")}<textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} /></label></>}
    </>}
    {transport === "stdio" && <label>{t("phaseB.machine")}<select required value={machineId} onChange={(e) => setMachine(e.target.value)}><option value="">—</option>{machines.data?.filter((m) => m.online || m.id === machineId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
    {entry && ["header", "env"].includes(entry.auth.kind) && <label>{t("phaseB.token")}<input type="password" required={!connection} value={token} autoComplete="new-password" onChange={(e) => setToken(e.target.value)} />{entry.auth.kind === "header" && <a className="link" href={entry.auth.tokenHelpUrl} target="_blank" rel="noreferrer">{t("phaseB.tokenHelp")}</a>}</label>}
    {!entry && connection && <Switch label={t("phaseB.replaceCredentials")} checked={replaceCredentials} onChange={setReplaceCredentials} />}
    {!entry && <Section title={t(transport === "http" ? "phaseB.headers" : "phaseB.env")} actions={<button type="button" className="button ghost sm" onClick={() => { setReplaceCredentials(true); setValues([...values, { key: "", value: "" }]); }}><Plus size={14} />{t("phaseB.addValue")}</button>}>
      {values.map((v, i) => <div className="connection-value-row" key={i}><input required aria-label={`${t("phaseB.key")} ${i + 1}`} value={v.key} onChange={(e) => setValues(values.map((v, j) => j === i ? { ...v, key: e.target.value } : v))} /><input type="password" aria-label={`${t("parity.value")} ${i + 1}`} autoComplete="new-password" value={v.value} onChange={(e) => setValues(values.map((v, j) => j === i ? { ...v, value: e.target.value } : v))} /><button type="button" className="button danger" aria-label={t("parity.remove")} onClick={() => setValues(values.filter((_, j) => j !== i))}><X size={12} /></button></div>)}
      {!values.length && <div className="settings-empty">{t(transport === "http" ? "phaseB.noHeaders" : "phaseB.noEnv")}</div>}
    </Section>}
    {!!connection?.secretKeys.length && <p className="hint">{t("phaseB.savedKeys", { keys: connection.secretKeys.join(", ") })}</p>}
    <p className="hint">{t("parity.writeOnly")}</p><ErrorNotice error={save.error || machines.error} />
    <div className="row dialog-actions"><button type="button" className="button ghost" onClick={onCancel}>{t("parity.cancel")}</button><button className="button primary" disabled={save.isPending || !valid}>{t(connection ? "parity.save" : "phaseB.connect")}</button></div>
  </form>;
}
function ConnectionDetails({ entry, connection, onClose }: { entry?: CatalogEntry; connection?: Connection; onClose: () => void }) {
  const { t, locale } = useI18n(); const client = useQueryClient(); const [editing, setEditing] = useState(false);
  const remove = useMutation({ mutationFn: () => request(`/connections/${connection!.id}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["connections"] }); void client.invalidateQueries({ queryKey: ["agent"] }); onClose(); } });
  const test = useMutation({ mutationFn: () => request<{ ok: boolean; toolCount: number; tools: string[]; error: string | null }>(`/connections/${connection!.id}/test`, "POST") });
  const name = connection?.name ?? entry?.name ?? t("phaseB.customConnection");
  return <Dialog title={name} onClose={onClose}><div className="dialog-body form-stack">
    <div className="connection-head"><span className="connection-monogram large" style={{ background: entry?.color ?? "var(--text-tertiary)" }}>{name.slice(0, 2)}</span><div><span className={`status-dot ${connection ? "ok" : ""}`}>{t(connection ? "phaseB.connected" : "phaseB.notConnected")}</span><span className="hint">{t(entry ? `phaseB.${entry.category}` : "phaseB.custom")}</span></div></div>
    {entry && <><p>{entry.description[locale]}</p><Section title={t("phaseB.capabilities")} description={t(`phaseB.${entry.category}`)}>{entry.capabilities[locale].map((text) => <SettingRow key={text} label={text} />)}</Section></>}
    <Section title={t("phaseB.details")}><SettingRow label={t((entry?.transport ?? connection?.transport) === "stdio" ? "phaseB.command" : "phaseB.url")}><code className="connection-address">{connection?.url ?? entry?.url ?? [connection?.command ?? entry?.command, ...(connection?.args ?? entry?.args ?? [])].join(" ")}</code></SettingRow>{entry && <SettingRow label={t("parity.source")}><a className="link" href={entry.docsUrl} target="_blank" rel="noreferrer">{entry.name}</a></SettingRow>}</Section>
    {test.data && <div role="status" className="settings-empty">{test.data.ok ? t("phaseB.testOk", { count: test.data.toolCount }) : t(connection?.transport === "stdio" ? "phaseB.stdioTest" : "phaseB.testFailed")}<div className="chip-list">{test.data.tools.map((tool) => <span className="chip" key={tool}>{tool}</span>)}</div></div>}
    <ErrorNotice error={test.error || remove.error} />
    {entry?.auth.kind === "oauth" ? <p className="hint">{t("phaseB.oauth")}</p> : (!connection || editing) && <ConnectionForm {...(entry ? { entry } : {})} {...(connection ? { connection } : {})} onSaved={onClose} onCancel={onClose} />}
    {connection && <div className="row dialog-actions"><button className="button ghost" disabled={test.isPending} onClick={() => test.mutate()}>{t("phaseB.test")}</button><button className="button ghost" onClick={() => setEditing(!editing)}>{t("parity.edit")}</button><button className="button danger" aria-label={t("phaseB.disconnect")} disabled={remove.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) remove.mutate(); }}>{t("phaseB.disconnect")}</button></div>}
  </div></Dialog>;
}
export function ConnectionsPage() {
  const { t, locale } = useI18n(); const connections = useConnections(); const [filter, setFilter] = useState("all"); const [selected, setSelected] = useState<{ entry?: CatalogEntry; connection?: Connection } | null>(null); const [custom, setCustom] = useState(false);
  // Only offer categories that currently have something in them.
  const categories = (["all", "connected", "project", "docs", "comms", "monitoring", "database", "cloud", "payments", "browser", "desktop", "custom"] as const).filter((value) => value === "all" || (value === "connected" ? !!connections.data?.length : value === "custom" ? connections.data?.some((c) => !c.catalogId) : connectionCatalog.some((e) => e.category === value)));
  const cards: { entry?: CatalogEntry; connection?: Connection }[] = connectionCatalog.map((entry) => ({ entry, ...(connections.data?.find((c) => c.catalogId === entry.id) ? { connection: connections.data.find((c) => c.catalogId === entry.id)! } : {}) }));
  cards.push(...(connections.data ?? []).filter((c) => !connectionCatalog.some((e) => e.id === c.catalogId)).map((connection) => ({ connection })));
  const visible = cards.filter(({ entry, connection }) => filter === "all" || (filter === "connected" ? !!connection : filter === "custom" ? !entry : entry?.category === filter));
  return <div className="management-page"><header className="page-header"><h1>{t("phaseB.connections")}</h1><button className="button primary" onClick={() => setCustom(true)}><Plus size={14} />{t("phaseB.customConnection")}</button></header><div className="page-content"><div className="connection-filters"><Segmented label={t("phaseB.connections")} value={filter} onChange={setFilter} options={categories.map((value) => ({ value, label: t(`phaseB.${value}`) }))} /></div><ErrorNotice error={connections.error} />
    {connections.isPending ? <Loading /> : visible.length ? <div className="skill-grid">{visible.map((card) => <button className="skill-card" key={card.entry?.id ?? card.connection!.id} onClick={() => setSelected(card)}><h3><span className="connection-monogram" style={{ background: card.entry?.color ?? "var(--text-tertiary)" }}>{(card.entry?.name ?? card.connection!.name).slice(0, 2)}</span>{card.entry?.name ?? card.connection!.name}</h3><p>{card.entry?.description[locale] ?? card.connection?.url ?? card.connection?.command}</p><span className="card-footer"><span>{t(card.entry ? `phaseB.${card.entry.category}` : "phaseB.custom")}</span>{card.connection && <span className="status-dot ok">{t("phaseB.connected")}</span>}{card.entry?.auth.kind === "oauth" && !card.connection && <span>OAuth</span>}</span></button>)}</div> : <Empty title={t("phaseB.emptyFilter")} />}
    {selected && <ConnectionDetails {...selected} onClose={() => setSelected(null)} />}{custom && <Dialog title={t("phaseB.customConnection")} onClose={() => setCustom(false)}><div className="dialog-body"><ConnectionForm onSaved={() => setCustom(false)} onCancel={() => setCustom(false)} /></div></Dialog>}
  </div></div>;
}
