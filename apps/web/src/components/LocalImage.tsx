import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { Dialog } from "./ui";
import { absolutePath } from "../lib/localPaths";

export interface ImageContext { todoId: string; buildId: string; messageId: string; streaming?: boolean }
export function LocalImage({ src, alt, context }: { src: string; alt?: string | undefined; context?: ImageContext | undefined }) {
  const { t } = useI18n();
  let displayPath = absolutePath(src) ?? src;
  try { displayPath = decodeURIComponent(displayPath); } catch { /* retain malformed input for display only */ }
  const [url, setUrl] = useState<string>();
  const [state, setState] = useState<"loading" | "unavailable" | "remote" | "ready">("loading");
  const [expanded, setExpanded] = useState(false);
  const [showPath, setShowPath] = useState(false);
  const todoId = context?.todoId, buildId = context?.buildId, messageId = context?.messageId, streaming = context?.streaming;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined); setState("loading"); setExpanded(false); setShowPath(false);
    if (!todoId || !buildId || !messageId) { setState("unavailable"); return; }
    // The server authorizes persisted Markdown, never transient stream fragments.
    if (streaming) return;
    void (async () => {
      try {
        const response = await fetch(`/api/todos/${encodeURIComponent(todoId)}/images`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Muster-Image": "1" },
          body: JSON.stringify({ buildId, messageId, src }), signal: controller.signal,
        });
        if (!response.ok) { if (!controller.signal.aborted) setState(response.status === 409 ? "remote" : "unavailable"); return; }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl); setState("ready");
      } catch { if (!controller.signal.aborted) setState("unavailable"); }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, todoId, buildId, messageId, streaming]);
  const failed = () => { setState("unavailable"); setExpanded(false); };
  return <span className="local-image" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    {state === "ready" && url ? <button type="button" className="local-image-preview" onClick={() => setExpanded(true)} aria-label={t("localImage.enlarge")}><img src={url} alt={alt ?? ""} onError={failed} /></button>
      : <span role="status">{t(state === "loading" ? "localImage.loading" : state === "remote" ? "localImage.remote" : "localImage.unavailable")}</span>}
    <button type="button" className="local-path local-image-path" onClick={() => setShowPath(!showPath)} aria-expanded={showPath}>{displayPath}</button>
    {showPath && <input aria-label={t("localImage.path")} readOnly value={displayPath} onFocus={(event) => event.currentTarget.select()} />}
    {expanded && url && <Dialog title={alt || t("localImage.enlarge")} onClose={() => setExpanded(false)} wide><img className="local-image-full" src={url} alt={alt ?? ""} onError={failed} /></Dialog>}
  </span>;
}
