import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UsageRow } from "@muster/shared";
import { api } from "../api/client";
import { useAgents, useProjects } from "../api/queries";
import { useStored } from "../hooks/usePreferences";
import { useI18n } from "../i18n";
import { ErrorNotice, Loading, Segmented } from "../components/ui";

const ranges = ["7", "30", "90", "all"] as const;
const dimensions = ["model", "agent", "runtime", "workspace"] as const;
type Range = typeof ranges[number];
type Dimension = typeof dimensions[number];

interface Group { key: string; label: string; detail?: string | undefined; tokensIn: number; tokensOut: number; turns: number; durationMs: number }

/** Adds rows into groups by key, largest first. */
export function groupUsage(rows: UsageRow[], keyOf: (row: UsageRow) => string, labelOf: (row: UsageRow) => { label: string; detail?: string }) {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { key, ...labelOf(row), tokensIn: 0, tokensOut: 0, turns: 0, durationMs: 0 };
    group.tokensIn += row.tokensIn; group.tokensOut += row.tokensOut; group.turns += row.turns; group.durationMs += row.durationMs;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) || b.turns - a.turns);
}

/** Every day from the first to the last, so quiet days show as gaps rather than disappearing. */
export function dailyUsage(rows: UsageRow[], days: number | null) {
  const totals = new Map<string, { tokensIn: number; tokensOut: number }>();
  for (const row of rows) {
    const day = totals.get(row.day) ?? { tokensIn: 0, tokensOut: 0 };
    day.tokensIn += row.tokensIn; day.tokensOut += row.tokensOut;
    totals.set(row.day, day);
  }
  const keys = [...totals.keys()].sort();
  if (!keys.length) return [];
  const local = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const end = new Date();
  const start = days ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - days + 1) : new Date(`${keys[0]}T00:00:00`);
  const result: Array<{ day: string; tokensIn: number; tokensOut: number }> = [];
  for (const date = start; local(date) <= local(end); date.setDate(date.getDate() + 1)) {
    const day = local(date);
    result.push({ day, ...(totals.get(day) ?? { tokensIn: 0, tokensOut: 0 }) });
  }
  return result;
}

export function UsagePage() {
  const { t, label, formatNumber, formatDuration } = useI18n();
  const compact = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const [range, setRange] = useStored<Range>("usage-range", "30");
  const [dimension, setDimension] = useStored<Dimension>("usage-dimension", "model");
  const [hovered, setHovered] = useState<number | null>(null);
  const days = range === "all" ? null : Number(range);
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(days), refetchInterval: 30_000 });
  const agents = useAgents();
  const projects = useProjects();
  const rows = usage.data ?? [];
  const totalIn = rows.reduce((sum, row) => sum + row.tokensIn, 0);
  const totalOut = rows.reduce((sum, row) => sum + row.tokensOut, 0);
  const total = totalIn + totalOut;
  const model = (row: UsageRow) => row.model === "default" || !row.model ? t("usage.defaultModel") : row.model;
  const groups = dimension === "model"
    ? groupUsage(rows, (row) => `${row.runtime}\u0000${row.model}`, (row) => ({ label: model(row), detail: label("runtime", row.runtime) }))
    : dimension === "agent"
      ? groupUsage(rows, (row) => row.agentId ?? row.agentName, (row) => {
        const agent = agents.data?.find((item) => item.id === row.agentId);
        return agent?.isChief ? { label: agent.name, detail: "master" } : { label: agent?.name ?? row.agentName };
      })
      : dimension === "runtime"
        ? groupUsage(rows, (row) => row.runtime, (row) => ({ label: label("runtime", row.runtime) }))
        : groupUsage(rows, (row) => row.projectId ?? "", (row) => ({ label: projects.data?.find((item) => item.id === row.projectId)?.name ?? t("usage.noWorkspace") }));
  const max = Math.max(1, ...groups.map((group) => group.tokensIn + group.tokensOut));
  const daily = dailyUsage(rows, days);
  const dailyMax = Math.max(1, ...daily.map((day) => day.tokensIn + day.tokensOut));
  const hoveredDay = hovered === null ? undefined : daily[hovered];
  const tiles = [
    { label: t("usage.total"), value: compact(total) },
    { label: t("usage.input"), value: compact(totalIn) },
    { label: t("usage.output"), value: compact(totalOut) },
    { label: t("usage.turns"), value: formatNumber(rows.reduce((sum, row) => sum + row.turns, 0)) },
    { label: t("usage.duration"), value: formatDuration(rows.reduce((sum, row) => sum + row.durationMs, 0)) },
  ];
  return (
    <div className="management-page usage-page">
      <header className="page-header">
        <h1>{t("usage.title")}</h1>
        <Segmented label={t("usage.title")} value={range} onChange={setRange} options={ranges.map((value) => ({ value, label: t(`usage.range_${value}`) }))} />
      </header>
      <div className="page-content">
        <p className="muted usage-subtitle">{t("usage.subtitle")}</p>
        <ErrorNotice error={usage.error} />
        {usage.isPending ? <Loading /> : (
          <>
            <div className="usage-tiles">
              {tiles.map((tile) => (
                <div className="usage-tile" key={tile.label}>
                  <span>{tile.label}</span>
                  <strong>{tile.value}</strong>
                </div>
              ))}
            </div>
            {!rows.length ? <p className="muted usage-empty">{t("usage.empty")}</p> : (
              <>
                <section className="usage-section">
                  <div className="usage-section-head">
                    <h2>{t("usage.daily")}</h2>
                    <span className="muted usage-readout" aria-live="polite">
                      {hoveredDay
                        ? `${hoveredDay.day} · ${t("usage.input")} ${compact(hoveredDay.tokensIn)} · ${t("usage.output")} ${compact(hoveredDay.tokensOut)}`
                        : daily.length ? `${daily[0]!.day} – ${daily.at(-1)!.day}` : ""}
                    </span>
                  </div>
                  <div className="usage-daily" role="list" onMouseLeave={() => setHovered(null)}>
                    {daily.map((day, index) => {
                      const value = day.tokensIn + day.tokensOut;
                      return (
                        <div
                          role="listitem"
                          key={day.day}
                          className={`usage-day ${hovered === index ? "active" : ""}`}
                          onMouseEnter={() => setHovered(index)}
                          aria-label={`${day.day}：${compact(value)}`}
                          title={`${day.day}\n${t("usage.input")} ${formatNumber(day.tokensIn)}\n${t("usage.output")} ${formatNumber(day.tokensOut)}`}
                        >
                          <span style={{ height: value ? `max(2px, ${(value / dailyMax) * 100}%)` : 0 }} />
                        </div>
                      );
                    })}
                  </div>
                </section>
                <section className="usage-section">
                  <div className="usage-section-head">
                    <Segmented label={t("usage.title")} value={dimension} onChange={setDimension} options={dimensions.map((value) => ({ value, label: t(`usage.by_${value}`) }))} />
                  </div>
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th />
                        <th className="usage-bar-cell" />
                        <th>{t("usage.total")}</th>
                        <th>{t("usage.input")}</th>
                        <th>{t("usage.output")}</th>
                        <th>{t("usage.turns")}</th>
                        <th>{t("usage.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((group) => {
                        const value = group.tokensIn + group.tokensOut;
                        return (
                          <tr key={group.key}>
                            <th scope="row">
                              <span className="usage-name">{group.label}</span>
                              {group.detail && <small className="dim">{group.detail}</small>}
                            </th>
                            <td className="usage-bar-cell"><span className="usage-bar" style={{ width: value ? `max(2px, ${(value / max) * 100}%)` : 0 }} /></td>
                            <td>{compact(value)}</td>
                            <td>{compact(group.tokensIn)}</td>
                            <td>{compact(group.tokensOut)}</td>
                            <td>{formatNumber(group.turns)}</td>
                            <td>{total ? formatNumber(value / total, { style: "percent", maximumFractionDigits: 1 }) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </section>
              </>
            )}
            <p className="dim usage-note">{t("usage.note")}</p>
          </>
        )}
      </div>
    </div>
  );
}
