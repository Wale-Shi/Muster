import { MentionInput } from "./MentionInput";
import { useI18n } from "../i18n";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AtSign } from "lucide-react";
import { api } from "../api/client";
import { useAgents, useProjects } from "../api/queries";
import { Dialog, ErrorNotice } from "./ui";
import { ProjectMonogram } from "./ProjectMonogram";

export function NewTaskDialog({ onClose, initialProjectId }: { onClose: () => void; initialProjectId?: string | undefined }) {
  const { t, label } = useI18n(); const projects = useProjects(); const agents = useAgents();
  const [projectId, setProjectId] = useState(initialProjectId ?? ""); const [agentId, setAgentId] = useState(""); const [title, setTitle] = useState(""); const [spec, setSpec] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const client = useQueryClient(); const navigate = useNavigate(); const selectedProject = projectId || projects.data?.[0]?.id || "";
  const create = useMutation({
    mutationFn: (start: boolean) => api.createTodo({ projectId: selectedProject, agentId: agentId || null, title: title.trim(), spec, start }),
    onSuccess: (todo) => { void client.invalidateQueries({ queryKey: ["todos"] }); onClose(); void navigate(`/todos/${todo.id}`); },
  });
  const disabled = create.isPending || !selectedProject || !title.trim();
  return <Dialog title={t("ui.newTask")} onClose={onClose} wide headerActions={<div className="task-project-picker"><ProjectMonogram name={projects.data?.find((p) => p.id === selectedProject)?.name ?? ""} /><select aria-label={t("ws.workspace")} required value={selectedProject} onChange={(e) => setProjectId(e.target.value)}><option value="" disabled>{t("ws.select")}</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}><form ref={form} onSubmit={(e) => { e.preventDefault(); if (!disabled) create.mutate(true); }} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (!disabled) create.mutate(true); } }}>
    <div className="dialog-body form-stack">
      <ErrorNotice error={projects.error || agents.error} />{!projects.isPending && !projects.data?.length && <p className="notice">{t("ws.needWorkspace")}</p>}
      <input className="title-input" aria-label={t("ui.taskTitle")} placeholder={t("ui.whatNeedsToGetDone")} autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
      <MentionInput aria-label={t("ui.taskDescription")} placeholder={t("phaseC.template")} rows={9} value={spec} onValue={setSpec} onAgent={(id) => { if (!agentId) setAgentId(id); }} />
      <ErrorNotice error={create.error} />
    </div>
    <div className="dialog-footer task-footer"><div className="row"><button type="button" className="icon-button" aria-label={t("parity.mention")} onClick={() => { setSpec((s) => `${s}${s && !s.endsWith(" ") ? " " : ""}@`); requestAnimationFrame(() => { const input = form.current?.querySelector("textarea"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }); }}><AtSign size={16} /></button><select className="task-agent-select sm" aria-label={t("ui.agent")} value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">{t("ui.defaultAgent")}</option>{agents.data?.filter((a) => !a.isChief).map((a) => <option value={a.id} key={a.id}>{a.name} · {label("runtime", a.runtime)}</option>)}</select></div><div className="row"><button type="button" className="button ghost" disabled={disabled} onClick={() => create.mutate(false)}>{t("parity.save")}</button><button className="button primary" disabled={disabled}>{create.isPending ? t("ui.creating") : t("phaseC.saveStart")}</button></div></div>
  </form></Dialog>;
}
