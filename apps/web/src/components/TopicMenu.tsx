import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Topic } from "@muster/shared";
import { request } from "../api/client";
import { useI18n } from "../i18n";
import { Dialog, ErrorNotice } from "./ui";
export function TopicMenu({ topic, chiefId }: { topic: Topic; chiefId?: string | undefined }) {
  const { t } = useI18n(); const client = useQueryClient(); const navigate = useNavigate(); const [editing, setEditing] = useState(false); const [title, setTitle] = useState(topic.title);
  const menu = useRef<HTMLDetailsElement>(null);
  // <details> has no light-dismiss: close on outside press, Escape and after choosing an item.
  useEffect(() => {
    const close = (event: Event) => { const el = menu.current; if (el?.open && (event instanceof KeyboardEvent ? event.key === "Escape" : !el.contains(event.target as Node))) el.open = false; };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  const save = useMutation({ mutationFn: (remove: boolean) => request(`/topics/${topic.id}`, remove ? "DELETE" : "PATCH", remove ? undefined : { title }), onSuccess: (_, remove) => { void client.invalidateQueries({ queryKey: ["topics"] }); setEditing(false); if (remove) navigate("/"); } });
  return <><details ref={menu} className="topic-menu" onClick={(e) => { if ((e.target as HTMLElement).closest(".menu-item")) e.currentTarget.open = false; }}><summary className="icon-button" aria-label={t("phaseC.topicMenu")}>⋯</summary><div className="topic-menu-content"><button className="menu-item" onClick={() => { setTitle(topic.title); setEditing(true); }}>{t("phaseC.renameTopic")}</button><button className="menu-item danger" aria-label={t("phaseC.deleteTopic")} disabled={save.isPending} onClick={() => { if (window.confirm(t("parity.deleteConfirm"))) save.mutate(true); }}>{t("phaseC.deleteTopic")}</button>{chiefId && <Link className="menu-item" to={`/agents/${chiefId}`}>{t("phaseC.chiefSettings")}</Link>}<ErrorNotice error={save.error} /></div></details>{editing && <Dialog title={t("phaseC.renameTopic")} onClose={() => setEditing(false)}><form className="dialog-body form-stack" onSubmit={(e) => { e.preventDefault(); save.mutate(false); }}><label>{t("ui.topicName")}<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label><ErrorNotice error={save.error} /><button className="button primary" disabled={save.isPending || !title.trim()}>{t("parity.save")}</button></form></Dialog>}</>;
}
