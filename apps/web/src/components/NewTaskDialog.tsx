import { MentionInput } from "./MentionInput";
import { useI18n } from "../i18n";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AtSign, Paperclip, Tags, X } from "lucide-react";
import { api, request } from "../api/client";
import { useAgents, useProjects } from "../api/queries";
import { useStored } from "../hooks/usePreferences";
import { Dialog, ErrorNotice } from "./ui";
import { ProjectMonogram } from "./ProjectMonogram";

export function NewTaskDialog({ onClose, topicId, initialProjectId }: { onClose: () => void; topicId?: string; initialProjectId?: string | undefined }) {
  const { t, label } = useI18n(); const projects = useProjects(); const agents = useAgents();
  const [projectId, setProjectId] = useState(initialProjectId ?? ""); const [agentId, setAgentId] = useState(""); const [title, setTitle] = useState(""); const [spec, setSpec] = useState("");
  const [tags, setTags] = useState<string[]>([]); const [tag, setTag] = useState(""); const [showTags, setShowTags] = useState(false);
  const [files, setFiles] = useState<File[]>([]); const [filesError, setFilesError] = useState(""); const [uploaded, setUploaded] = useState(false);
  const [mode, setMode] = useStored<"plan" | "run">("new-task-mode", "plan"); const [createdId, setCreatedId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null); const form = useRef<HTMLFormElement>(null);
  const client = useQueryClient(); const navigate = useNavigate(); const selectedProject = projectId || projects.data?.[0]?.id || "";
  const addFiles = (incoming: File[]) => {
    const next = [...files, ...incoming];
    if (next.length > 10 || next.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024) { setFilesError(t("phaseC.attachmentLimit")); return; }
    setFiles(next); setFilesError("");
  };
  const create = useMutation({
    mutationFn: async (start: boolean) => {
      const todoId = createdId ?? (await api.createTodo({ projectId: selectedProject, agentId: agentId || null, title: title.trim(), spec, tags, mode, ...(topicId ? { topicId } : {}) })).id;
      setCreatedId(todoId);
      await client.invalidateQueries({ queryKey: ["todos"] });
      if (files.length && !uploaded) { const data = new FormData(); for (const file of files) data.append("files", file); await request(`/todos/${todoId}/attachments`, "POST", data); setUploaded(true); }
      if (start) await api.action(todoId, "start", { mode, ...(agentId ? { agentId } : {}) });
      return todoId;
    },
    onSuccess: (id) => { void client.invalidateQueries({ queryKey: ["todos"] }); onClose(); void navigate(`/todos/${id}`); },
  });
  const disabled = create.isPending || !selectedProject || !title.trim();
  const addTag = () => { if (tag.trim() && !tags.includes(tag.trim())) setTags([...tags, tag.trim()]); setTag(""); };
  return <Dialog title={t("ui.newTask")} onClose={onClose} wide headerActions={<div className="task-project-picker"><ProjectMonogram name={projects.data?.find((p) => p.id === selectedProject)?.name ?? ""} /><select aria-label={t("ui.project")} required value={selectedProject} disabled={!!createdId} onChange={(e) => setProjectId(e.target.value)}><option value="" disabled>{t("ui.selectProject")}</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}><form ref={form} onSubmit={(e) => { e.preventDefault(); if (!disabled) create.mutate(true); }} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (!disabled) create.mutate(true); } }}>
    <div className="dialog-body form-stack" onDragOver={(e) => { if (!createdId) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (!createdId) addFiles(Array.from(e.dataTransfer.files)); }}>

      <ErrorNotice error={projects.error || agents.error} />{!projects.isPending && !projects.data?.length && <p className="notice">{t("ui.createAProjectInProjectsBeforeAddingATask")}</p>}
      <input className="title-input" aria-label={t("ui.taskTitle")} placeholder={t("ui.whatNeedsToGetDone")} autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} disabled={!!createdId} />
      <MentionInput aria-label={t("ui.taskDescription")} placeholder={t("phaseC.template")} rows={9} value={spec} onValue={setSpec} onAgent={(id) => { if (!agentId) setAgentId(id); }} disabled={!!createdId} />
      {(showTags || tags.length > 0) && <div className="chip-list">{tags.map((value) => <span className="chip" key={value}>{value}<button type="button" className="icon-button" aria-label={`${t("phaseC.remove")} ${value}`} disabled={!!createdId} onClick={() => setTags(tags.filter((t) => t !== value))}><X size={12} /></button></span>)}<input aria-label={t("phaseC.tags")} placeholder={t("phaseC.addTag")} value={tag} disabled={!!createdId} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } if (e.key === "Backspace" && !tag) setTags(tags.slice(0, -1)); }} /></div>}
      {files.length > 0 && <div className="chip-list">{files.map((file, index) => <span className="chip" key={index}><Paperclip size={12} />{file.name}<button type="button" className="icon-button" disabled={!!createdId} aria-label={`${t("phaseC.remove")} ${file.name}`} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={12} /></button></span>)}</div>}
      <input hidden type="file" ref={fileInput} aria-label={t("phaseC.attachments")} multiple disabled={!!createdId} onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <ErrorNotice error={create.error || filesError} />{createdId && create.isError && <p className="hint">{t("ui.taskSavedRetryStartingItOrOpenItFromTheBoard")}</p>}
    </div>
    <div className="dialog-footer task-footer"><div className="row"><button type="button" className="icon-button" aria-label={t("phaseC.tags")} onClick={() => setShowTags(!showTags)}><Tags size={16} /></button><button type="button" className="icon-button" aria-label={t("phaseC.attachments")} title={t("phaseC.attachmentHelp")} disabled={!!createdId} onClick={() => fileInput.current?.click()}><Paperclip size={16} /></button><button type="button" className="icon-button" aria-label={t("parity.mention")} disabled={!!createdId} onClick={() => { setSpec((s) => `${s}${s && !s.endsWith(" ") ? " " : ""}@`); requestAnimationFrame(() => { const input = form.current?.querySelector("textarea"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }); }}><AtSign size={16} /></button><select className="task-agent-select sm" aria-label={t("ui.agent")} value={agentId} disabled={!!createdId} onChange={(e) => setAgentId(e.target.value)}><option value="">{t("ui.defaultAgent")}</option>{agents.data?.filter((a) => !a.isChief).map((a) => <option value={a.id} key={a.id}>{a.name} · {label("runtime", a.runtime)}</option>)}</select></div><div className="row"><button type="button" className="button ghost" disabled={disabled} onClick={() => create.mutate(false)}>{t("parity.save")}</button><div className="task-split-action"><button className="button primary" disabled={disabled}>{create.isPending ? t("ui.creating") : t("phaseC.saveStart")}</button><select aria-label={t("phaseC.saveStart")} value={mode} disabled={create.isPending} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="plan">{t("ui.planFirst")}</option><option value="run">{t("ui.runNow")}</option></select></div></div></div>
  </form></Dialog>;
}
