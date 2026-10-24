import { useI18n } from "../i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, X } from "lucide-react";
import { api } from "../api/client";
import { ErrorNotice } from "./ui";

export function QueuedMessages({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const messages = useQuery({ queryKey: ["queued-messages", conversationId], queryFn: () => api.queuedMessages(conversationId), enabled: !!conversationId });
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const change = useMutation({
    mutationFn: ({ id, content }: { id: string; content?: string }) => content === undefined ? api.retractQueued(conversationId, id) : api.editQueued(conversationId, id, content),
    onSuccess: () => { setEditing(null); void client.invalidateQueries({ queryKey: ["queued-messages", conversationId] }); },
  });
  if (!messages.data?.length && !messages.error) return null;
  return <div className="queued-tray">
    <div><MessageSquare size={12} /><strong>{t("ui.queuedForThisRun")}</strong></div>
    {messages.data?.map((message) => <div key={message.id}>
      {editing === message.id ? <form onSubmit={(event) => { event.preventDefault(); change.mutate({ id: message.id, content: text }); }}>
        <input aria-label={t("ui.editQueuedMessage")} value={text} onChange={(event) => setText(event.target.value)} />
        <button className="button" disabled={!text.trim() || change.isPending}>{t("ui.save")}</button>
        <button className="button" type="button" onClick={() => setEditing(null)}>{t("ui.cancel")}
        </button>
      </form> : <p>{message.content}</p>}
      {message.delivering ? <span className="hint">{t("ui.delivering")}</span> : <>
        <button className="icon-button" aria-label={t("text.editMessage", { content: message.content })} disabled={change.isPending} onClick={() => { setEditing(message.id); setText(message.content); }}><Pencil size={12} /></button>
        <button className="icon-button" aria-label={t("text.retract", { content: message.content })} disabled={change.isPending} onClick={() => change.mutate({ id: message.id })}><X size={12} /></button>
      </>}
    </div>)}
    <ErrorNotice error={messages.error || change.error} />
  </div>;
}
