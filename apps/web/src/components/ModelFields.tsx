import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { CLI_DEFAULT_MODEL, DEFAULT_MODELS, runtimeInfo, type Machine, type Runtime, type RuntimeModel } from "@muster/shared";
import { api } from "../api/client";
import { useMachines } from "../api/queries";
import { useI18n } from "../i18n";

const CUSTOM = "__custom__";
const FALLBACK_REASONING = ["low", "medium", "high"];

export interface RuntimeModelList { models: RuntimeModel[]; errors: string[]; reported: boolean }

/** Models every enrolled machine reported for a runtime, merged by id. */
export function runtimeModels(machines: Machine[] | undefined, runtime: Runtime): RuntimeModelList {
  const byId = new Map<string, RuntimeModel>(); const errors: string[] = []; let reported = false;
  for (const machine of machines ?? []) {
    const entry = machine.models?.[runtime];
    if (!entry) continue;
    reported = true;
    if (entry.error) errors.push(`${machine.name}: ${entry.error}`);
    for (const model of entry.models) {
      const known = byId.get(model.id);
      byId.set(model.id, known ? { ...known, reasoning: [...new Set([...(known.reasoning ?? []), ...(model.reasoning ?? [])])] } : model);
    }
  }
  return { models: [...byId.values()], errors, reported };
}

/** Whether the runtime's adapter can leave the model choice to the CLI. */
const allowsCliDefault = (runtime: Runtime) => runtimeInfo(runtime).protocol !== "mock";

/** The model to preselect when switching to a runtime: its default if offered, else the first reported one. */
export function initialModel(machines: Machine[] | undefined, runtime: Runtime): string {
  const { models } = runtimeModels(machines, runtime);
  const preferred = DEFAULT_MODELS[runtime];
  if (preferred === CLI_DEFAULT_MODEL || !models.length || models.some((m) => m.id === preferred)) return preferred;
  return models[0]!.id;
}

/** Reasoning levels the chosen model supports, or every level its runtime reports, or a generic ladder. */
export function reasoningLevels(machines: Machine[] | undefined, runtime: Runtime, model: string): string[] {
  const models = runtimeModels(machines, runtime).models;
  const levels = model === CLI_DEFAULT_MODEL ? models.flatMap((m) => m.reasoning ?? []) : models.find((m) => m.id === model)?.reasoning;
  return levels?.length ? [...new Set(levels)] : FALLBACK_REASONING;
}

/** Keeps a reasoning level only if the newly chosen model supports it. */
export function keepReasoning(machines: Machine[] | undefined, runtime: Runtime, model: string, reasoning: string | null | undefined): string | null {
  return reasoning && reasoningLevels(machines, runtime, model).includes(reasoning) ? reasoning : null;
}

/** The model's name, plus its id when the name does not already spell it out. */
export function modelLabel(model: RuntimeModel): string {
  const name = model.name?.trim();
  const tail = model.id.split(/[:/]/).pop()!.toLowerCase();
  return !name ? model.id : name.toLowerCase().includes(tail) ? name : `${name} · ${model.id}`;
}

export function ModelSelect({ runtime, value, onChange, label }: { runtime: Runtime; value: string; onChange(model: string): void; label: string }) {
  const { t } = useI18n();
  const machines = useMachines();
  const list = runtimeModels(machines.data, runtime);
  const [custom, setCustom] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const listed = list.models.some((m) => m.id === value) || (value === CLI_DEFAULT_MODEL && allowsCliDefault(runtime));
  const refresh = async () => {
    setRefreshing(true);
    try { await api.refreshModels(); } finally { setTimeout(() => { void machines.refetch(); setRefreshing(false); }, 4000); }
  };
  return (
    <div className="model-field">
      {custom ? (
        <div className="model-custom">
          <input className="mono" autoFocus aria-label={label} defaultValue={listed ? "" : value} placeholder={t("ui.modelIdentifier")}
            onBlur={(e) => { const model = e.target.value.trim(); if (model) onChange(model); setCustom(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setCustom(false); }} />
        </div>
      ) : (
        <select aria-label={label} value={value} onChange={(e) => { if (e.target.value === CUSTOM) setCustom(true); else onChange(e.target.value); }}>
          {allowsCliDefault(runtime) && <option value={CLI_DEFAULT_MODEL}>{t("ui.modelCliDefault")}</option>}
          {list.models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
          {!listed && <option value={value}>{`${value} · ${t("ui.modelNotReported")}`}</option>}
          <option value={CUSTOM}>{t("ui.modelCustom")}</option>
        </select>
      )}
      <div className="model-status">
        <span className={list.errors.length && !list.models.length ? "warning-text" : "muted"} title={list.errors.join("\n")}>
          {!list.reported ? t("ui.modelsNotReported")
            : list.errors.length && !list.models.length ? t("ui.modelsFailed")
            : t("count.models", { count: list.models.length })}
        </span>
        <button type="button" className="link-button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={12} className={refreshing ? "spin" : ""} />{refreshing ? t("ui.modelsRefreshing") : t("ui.modelsRefresh")}
        </button>
      </div>
    </div>
  );
}

export function ReasoningSelect({ levels, value, onChange, label }: { levels: string[]; value: string | null; onChange(reasoning: string | null): void; label: string }) {
  const { t } = useI18n();
  const options = value && !levels.includes(value) ? [...levels, value] : levels;
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t("ui.reasoningDefault")}</option>
      {options.map((level) => <option key={level} value={level}>{level}</option>)}
    </select>
  );
}
