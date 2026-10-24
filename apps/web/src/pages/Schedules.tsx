import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus } from "lucide-react";
import type { Schedule, ScheduleInput } from "@muster/shared";
import { request } from "../api/client";
import { useAgents, useMachines, useProjects, useTodos } from "../api/queries";
import { useI18n } from "../i18n";
import { Dialog, Empty, ErrorNotice, Loading, Section, Segmented, SettingRow, Switch } from "../components/ui";

export const useSchedules = (todoId?: string) => useQuery({ queryKey: ["schedules", todoId ?? "all"], queryFn: () => request<Schedule[]>(`/schedules${todoId ? `?todoId=${todoId}` : ""}`) });
export function cadenceLabel(s: ScheduleInput, i18n: ReturnType<typeof useI18n>): string {
  const { t, locale } = i18n; const zone = s.timezone;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, s.hour ?? 0, s.minute)));
  if (s.cadence === "hourly") return t("phaseB.hourlyText", { minute: s.minute, zone });
  if (s.cadence === "once") return t("phaseB.onceText", { time: s.runAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(s.runAt)) : "—", zone });
  if (s.cadence === "weekly") return t("phaseB.weeklyText", { day: new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + (s.weekday ?? 0)))), time, zone });
  return t("phaseB.dailyText", { time, zone });
}
export function ScheduleDialog({ schedule, todoId, onClose }: { schedule?: Schedule; todoId?: string; onClose: () => void }) {
  const { t, locale } = useI18n(); const client = useQueryClient(); const todos = useTodos(); const projects = useProjects(); const agents = useAgents(); const machines = useMachines();
  const [task, setTask] = useState(schedule?.todoId ?? todoId ?? ""); const [project, setProject] = useState(""); const [search, setSearch] = useState("");
  const [cadence, setCadence] = useState<ScheduleInput["cadence"]>(schedule?.cadence ?? "daily");
  const [time, setTime] = useState(`${String(schedule?.hour ?? 9).padStart(2, "0")}:${String(schedule?.minute ?? 0).padStart(2, "0")}`);
  const [minute, setMinute] = useState(schedule?.minute ?? 0); const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const localDate = (iso: string) => { const d = new Date(iso); return new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [once, setOnce] = useState(schedule?.runAt ? localDate(schedule.runAt) : "");
  const [mode, setMode] = useState<"plan" | "run">(schedule?.mode ?? "plan"); const [agentId, setAgent] = useState(schedule?.agentId ?? ""); const [machineId, setMachine] = useState(schedule?.machineId ?? "");
  const zone = schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selectedProject = project || todos.data?.find((x) => x.id === task)?.projectId || "";
  const save = useMutation({ mutationFn: () => { const [hour, min] = time.split(":").map(Number); return request(`/schedules${schedule ? `/${schedule.id}` : ""}`, schedule ? "PATCH" : "POST", { todoId: task, cadence, minute: cadence === "hourly" ? minute : min, hour, weekday, runAt: cadence === "once" ? new Date(once).toISOString() : null, timezone: cadence === "once" ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone, mode, agentId: agentId || null, machineId: machineId || null }); }, onSuccess: () => { void client.invalidateQueries({ queryKey: ["schedules"] }); onClose(); } });
  return <Dialog title={t(schedule ? "phaseB.editSchedule" : "phaseB.newSchedule")} onClose={onClose}><div className="dialog-body"><form className="form-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
    <label>{t("phaseB.projectLabel")}<select required value={selectedProject} onChange={(e) => { setProject(e.target.value); setTask(""); }}><option value="">—</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <label>{t("phaseB.searchTask")}<input value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    <label>{t("phaseB.task")}<select required value={task} onChange={(e) => setTask(e.target.value)}><option value="">—</option>{todos.data?.filter((x) => x.projectId === selectedProject && (x.id === task || `${x.number} ${x.title}`.toLowerCase().includes(search.toLowerCase()))).map((x) => <option key={x.id} value={x.id}>#{x.number} {x.title}</option>)}</select></label>
    <Segmented label={t("phaseB.cadence")} value={cadence} onChange={setCadence} options={(["hourly", "daily", "weekly", "once"] as const).map((value) => ({ value, label: t(`phaseB.${value}`) }))} />
    {cadence === "hourly" ? <label>{t("phaseB.minute")}<input type="number" min={0} max={59} required value={minute} onChange={(e) => setMinute(Number(e.target.value))} /></label> : cadence === "once" ? <label>{t("phaseB.date")}<input type="datetime-local" required value={once} onChange={(e) => setOnce(e.target.value)} /></label> : <>
      {cadence === "weekly" && <label>{t("phaseB.weekday")}<select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{Array.from({ length: 7 }, (_, day) => <option key={day} value={day}>{new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 4 + day)))}</option>)}</select></label>}
      <label>{t("phaseB.time")}<input type="time" required value={time} onChange={(e) => setTime(e.target.value)} /></label></>}
    <p className="hint">{t("phaseB.timezoneNote", { zone })}</p>
    <Segmented label={t("phaseB.mode")} value={mode} onChange={setMode} options={[{ value: "plan", label: t("phaseB.plan") }, { value: "run", label: t("phaseB.run") }]} />
    <label>{t("phaseB.agent")}<select value={agentId} onChange={(e) => setAgent(e.target.value)}><option value="">{t("phaseB.followTask")}</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <label>{t("phaseB.machine")}<select value={machineId} onChange={(e) => setMachine(e.target.value)}><option value="">{t("phaseB.auto")}</option>{machines.data?.filter((m) => m.online || m.id === machineId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <ErrorNotice error={save.error || todos.error || projects.error || agents.error || machines.error} />
    <div className="row dialog-actions"><button type="button" className="button ghost" onClick={onClose}>{t("parity.cancel")}</button><button className="button primary" disabled={save.isPending || !task}>{t("parity.save")}</button></div>
  </form></div></Dialog>;
}
export function TodoSchedules({ todoId }: { todoId: string }) {
  const i18n = useI18n(); const schedules = useSchedules(todoId); const [open, setOpen] = useState(false);
  return <><button className="button ghost sm" onClick={() => setOpen(true)}><Clock size={14} />{i18n.t("phaseB.repeat")}</button>{schedules.data?.filter((s) => s.enabled).map((s) => <Link key={s.id} className="chip" to="/schedules">{i18n.t("phaseB.repeats", { cadence: cadenceLabel(s, i18n) })}</Link>)}{open && <ScheduleDialog todoId={todoId} onClose={() => setOpen(false)} />}</>;
}
export function SchedulesPage() {
  const i18n = useI18n(); const { t, formatRelative, formatDate } = i18n; const schedules = useSchedules(); const todos = useTodos(); const projects = useProjects(); const client = useQueryClient(); const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const mutate = useMutation({ mutationFn: ({ s, action }: { s: Schedule; action: "toggle" | "run" | "delete" }) => request(`/schedules/${s.id}${action === "run" ? "/run" : ""}`, action === "toggle" ? "PATCH" : action === "run" ? "POST" : "DELETE", action === "toggle" ? { enabled: !s.enabled } : undefined), onSuccess: () => { void client.invalidateQueries({ queryKey: ["schedules"] }); } });
  const add = <button className="button primary" onClick={() => setEditing("new")}><Plus size={14} />{t("phaseB.newSchedule")}</button>;
  return <div className="management-page"><header className="page-header"><h1>{t("phaseB.schedules")}</h1>{add}</header><div className="page-content"><div className="profile-content"><div className="page-intro"><h2>{t("phaseB.schedules")}</h2><p>{t("phaseB.scheduleIntro")}</p></div><ErrorNotice error={schedules.error || mutate.error} />
    {schedules.isPending ? <Loading /> : !schedules.data?.length ? <Empty icon={<Clock size={20} />} title={t("phaseB.scheduleEmpty")} action={add}>{t("phaseB.chiefHelp")}</Empty> : <Section title={t("phaseB.schedules")}>{schedules.data.map((s) => { const todo = todos.data?.find((x) => x.id === s.todoId); return <SettingRow key={s.id} label={<Link to={`/todos/${s.todoId}`}>#{todo?.number} {todo?.title ?? s.todoId}</Link>} help={<span className="schedule-description"><span>{projects.data?.find((p) => p.id === todo?.projectId)?.name} · {cadenceLabel(s, i18n)}</span><span title={s.nextRunAt ? formatDate(s.nextRunAt, { dateStyle: "full", timeStyle: "long" }) : undefined}>{s.nextRunAt ? t("phaseB.nextRun", { time: formatRelative(s.nextRunAt) }) : t("phaseB.noNext")}</span></span>}>
      <span className="chip" title={s.lastError ?? undefined}>{t(s.lastResult ? `phaseB.${s.lastResult}` : "phaseB.never")}</span><Switch label={t("phaseB.enabled")} checked={s.enabled} disabled={mutate.isPending} onChange={() => mutate.mutate({ s, action: "toggle" })} />
      <details className="schedule-menu"><summary className="button ghost" aria-label={t("phaseB.menu")}>···</summary><div className="form-stack"><button className="button ghost" disabled={mutate.isPending} onClick={() => mutate.mutate({ s, action: "run" })}>{t("phaseB.run")}</button><button className="button ghost" onClick={() => setEditing(s)}>{t("parity.edit")}</button><button className="button danger" aria-label={t("parity.delete")} disabled={mutate.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) mutate.mutate({ s, action: "delete" }); }}>{t("parity.delete")}</button></div></details>
    </SettingRow>; })}</Section>}
    {editing && <ScheduleDialog {...(editing === "new" ? {} : { schedule: editing })} onClose={() => setEditing(null)} />}
  </div></div></div>;
}
