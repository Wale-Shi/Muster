import { useId, useRef, useState, type Ref, type TextareaHTMLAttributes } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Skill } from "@muster/shared";
import { request } from "../api/client";
import { useI18n } from "../i18n";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "ref"> & { value: string; onValue: (value: string) => void; onAgent?: (id: string) => void; ref?: Ref<HTMLTextAreaElement> };
export function MentionInput({ value, onValue, onAgent, ref, onKeyDown, ...props }: Props) {
  const { t } = useI18n(); const listId = useId(); const input = useRef<HTMLTextAreaElement | null>(null); const [cursor, setCursor] = useState(0); const [active, setActive] = useState(0); const [dismissed, setDismissed] = useState(false);
  const match = /(?:^|\s)@([\w-]*)$/.exec(value.slice(0, cursor)); const open = !!match && !dismissed;
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => request<Agent[]>("/agents"), enabled: open });
  const skills = useQuery({ queryKey: ["skills"], queryFn: () => request<Skill[]>("/skills"), enabled: open });
  const items = [...(agents.data ?? []).map((a) => ({ id: a.id, name: a.name, slug: a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || a.id, agent: true })), ...(skills.data ?? []).map((s) => ({ id: s.id, name: s.name, slug: s.slug, agent: false }))].filter((item) => `${item.name} ${item.slug}`.toLowerCase().includes(match?.[1]?.toLowerCase() ?? "")).slice(0, 12);
  const select = (item: typeof items[number]) => {
    const start = cursor - (match?.[1]?.length ?? 0) - 1; const insertion = `@${item.slug} `; onValue(value.slice(0, start) + insertion + value.slice(cursor)); setDismissed(true); if (item.agent) onAgent?.(item.id);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + insertion.length, start + insertion.length); });
  };
  return <div className="mention-input"><textarea {...props} ref={(element) => { input.current = element; if (typeof ref === "function") ref(element); else if (ref) ref.current = element; }} value={value} aria-controls={open ? listId : undefined} aria-activedescendant={open && items.length ? `${listId}-${Math.min(active, items.length - 1)}` : undefined} onChange={(e) => { onValue(e.target.value); setCursor(e.target.selectionStart); setActive(0); setDismissed(false); }} onClick={(e) => setCursor(e.currentTarget.selectionStart)} onKeyDown={(e) => {
    if (open && items.length) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length); return; } if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); select(items[Math.min(active, items.length - 1)]!); return; } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); return; } } onKeyDown?.(e);
  }} />{open && items.length > 0 && <div className="mention-picker" role="listbox" id={listId} aria-label={t("parity.mentions")}>{items.map((item, index) => <button type="button" role="option" id={`${listId}-${index}`} aria-selected={index === active} key={`${item.agent}:${item.id}`} onMouseDown={(e) => e.preventDefault()} onClick={() => select(item)}><strong>{item.name}</strong><span className="muted">{t(item.agent ? "parity.agent" : "parity.skills")} · @{item.slug}</span></button>)}</div>}</div>;
}
