import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, FileText, FolderUp, Plus, Trash2 } from "lucide-react";
import type { Agent, Skill, SkillFile } from "@muster/shared";
import { request } from "../api/client";
import { useI18n } from "../i18n";
import { Empty, ErrorNotice, Loading, Section, Segmented, SettingRow } from "../components/ui";

type Preview = { name: string; description: string; files: SkillFile[]; source: { type: string; url?: string } }[];

export function SkillsPage() {
  const { t } = useI18n(); const skills = useQuery({ queryKey: ["skills"], queryFn: () => request<Skill[]>("/skills") });
  return (
    <div className="management-page">
      <header className="page-header"><h1>{t("parity.skills")}</h1><Link className="button primary" to="/skills/new"><Plus size={14} />{t("parity.newSkill")}</Link></header>
      <div className="page-content">
        <div className="page-intro"><h2>{t("parity.skillsTitle")}</h2><p>{t("parity.skillHelp")}</p></div>
        <ErrorNotice error={skills.error} />
        {skills.isPending ? <Loading /> : !skills.data?.length
          ? <Empty icon={<BookOpen size={20} />} title={t("parity.skillEmpty")} action={<Link className="button primary" to="/skills/new"><Plus size={14} />{t("parity.newSkill")}</Link>}>{t("parity.skillEmptyHelp")}</Empty>
          : <div className="skill-grid">{skills.data.map((s) => <Link className="skill-card" key={s.id} to={`/skills/${s.slug}`}><h3><span className="skill-icon"><BookOpen size={14} /></span>{s.name}</h3><p>{s.description}</p><span className="mono">@{s.slug}</span></Link>)}</div>}
      </div>
    </div>
  );
}

export function NewSkillPage() {
  const { t } = useI18n(); const navigate = useNavigate(); const client = useQueryClient();
  const [tab, setTab] = useState<"folder" | "bulk" | "github">("folder"); const [files, setFiles] = useState<File[]>([]); const [url, setUrl] = useState(""); const [preview, setPreview] = useState<Preview | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (preview) return request<Skill[]>("/skills/import", "POST", preview);
      if (tab === "github") return request<Preview>("/skills/github?preview=true", "POST", { url });
      const form = new FormData(); for (const file of files) form.append("files", file, file.webkitRelativePath || file.name); form.append("bulk", String(tab === "bulk"));
      return request<Preview>("/skills/upload?preview=true", "POST", form);
    },
    onSuccess: (result) => {
      if (!preview) { setPreview(result as Preview); return; }
      const created = result as Skill[]; void client.invalidateQueries({ queryKey: ["skills"] }); navigate(created.length === 1 ? `/skills/${created[0]!.slug}` : "/skills");
    },
  });
  const folder = files[0]?.webkitRelativePath.split("/")[0];
  const reset = () => { setPreview(null); save.reset(); };
  return (
    <div className="management-page">
      <header className="page-header"><div className="breadcrumb"><Link to="/skills">{t("parity.skills")}</Link><span>/</span><span>{t("parity.newSkill")}</span></div></header>
      <div className="page-content">
        <div className="profile-content">
          <div className="page-intro"><h2>{t("parity.newSkill")}</h2><p>{t("parity.newSkillHelp")}</p></div>
          <Segmented label={t("parity.newSkill")} value={tab} onChange={(value) => { setTab(value); setFiles([]); reset(); }} options={[{ value: "folder", label: t("parity.folder") }, { value: "bulk", label: t("parity.bulk") }, { value: "github", label: t("parity.github") }]} />
          <form className="settings-card skill-form" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
            {preview ? preview.map((skill, index) => (
              <div className="skill-preview form-stack" key={index}>
                <label>{t("parity.name")}<input required value={skill.name} onChange={(e) => setPreview(preview.map((s, i) => i === index ? { ...s, name: e.target.value } : s))} /></label>
                <label>{t("parity.description")}<textarea required rows={4} value={skill.description} onChange={(e) => setPreview(preview.map((s, i) => i === index ? { ...s, description: e.target.value } : s))} /></label>
                <span className="hint">{t("parity.fileCount", { count: skill.files.length })}</span>
              </div>
            )) : tab === "github"
              ? <label>{t("parity.githubUrl")}<input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/tree/main/skills/example" /><span className="hint">{t("parity.githubHelp")}</span></label>
              : <label className="drop-zone">
                  <FolderUp size={20} />
                  <span>{folder ? `${folder} · ${t("parity.fileCount", { count: files.length })}` : t("parity.chooseFolder")}</span>
                  <small>{t(tab === "bulk" ? "parity.bulkHelp" : "parity.folderHelp")}</small>
                  <input type="file" multiple {...{ webkitdirectory: "" }} onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); reset(); }} />
                </label>}
            <ErrorNotice error={save.error} />
            <div className="row">
              {preview && <button type="button" className="button ghost" onClick={reset}>{t("parity.back")}</button>}
              <button className="button primary" disabled={save.isPending || (tab === "github" ? !url : !files.length)}>{save.isPending ? t("parity.loading") : preview ? t(preview.length > 1 ? "parity.importCount" : "parity.import", { count: preview.length }) : t("parity.preview")}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export function SkillPage() {
  const { slug = "" } = useParams(); const { t, formatDate } = useI18n(); const navigate = useNavigate(); const client = useQueryClient();
  const skill = useQuery({ queryKey: ["skill", slug], queryFn: () => request<Skill & { instructions: string; files: string[]; agents: Agent[] }>(`/skills/${slug}`) });
  const remove = useMutation({ mutationFn: () => request(`/skills/${slug}`, "DELETE"), onSuccess: () => { void client.invalidateQueries({ queryKey: ["skills"] }); navigate("/skills"); } });
  const s = skill.data;
  return (
    <div className="management-page">
      <header className="page-header"><div className="breadcrumb"><Link to="/skills">{t("parity.skills")}</Link><span>/</span><span>{s?.name ?? slug}</span></div><button className="button danger" disabled={!s || remove.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) remove.mutate(); }}><Trash2 size={14} />{t("parity.delete")}</button></header>
      <div className="page-content">
        <ErrorNotice error={skill.error || remove.error} />
        {!s ? skill.isPending && <Loading /> : <div className="profile-content">
          <div className="page-intro"><h2>{s.name}</h2><p>{s.description}</p></div>
          <Section title={t("parity.details")}>
            <SettingRow label={t("parity.mention")}><span className="mono muted">@{s.slug}</span></SettingRow>
            <SettingRow label={t("parity.source")}>{typeof s.source.url === "string" ? <a className="link" href={s.source.url} target="_blank" rel="noreferrer">{s.source.url.replace("https://github.com/", "")}</a> : <span className="muted">{t(s.source.type === "authored" ? "parity.authored" : "parity.folder")}</span>}</SettingRow>
            {s.updatedAt && <SettingRow label={t("parity.updated")}><span className="muted">{formatDate(s.updatedAt)}</span></SettingRow>}
            <SettingRow label={t("parity.usedBy")} help={s.agents.length ? undefined : t("parity.noAgents")}>{s.agents.map((a) => <Link className="chip" key={a.id} to={`/agents/${a.id}`}>{a.name}</Link>)}</SettingRow>
          </Section>
          <Section title={t("parity.files")}>{s.files.map((file) => <div className="file-row mono" key={file}><FileText size={12} /> {file}</div>)}</Section>
          <Section title="SKILL.md"><div className="markdown markdown-card"><ReactMarkdown remarkPlugins={[remarkGfm]}>{s.instructions.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}</ReactMarkdown></div></Section>
        </div>}
      </div>
    </div>
  );
}
