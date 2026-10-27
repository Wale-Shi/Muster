import { useI18n } from "../i18n";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock3 } from "lucide-react";
import { api } from "../api/client";
import { Empty, ErrorNotice, Loading } from "../components/ui";

type Row = { label: string; input: number; output: number; durationMs: number };
function TokenChart({ rows }: { rows: Row[] }) {
  const { t, formatNumber } = useI18n();
  const number = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const max = Math.max(1, ...rows.map((row) => row.input + row.output));
  return (
    <div className="token-chart">
      <div className="chart-legend">
        <span>
          <i className="legend-input" />
          {t("ui.input")}
        </span>
        <span>
          <i className="legend-output" />
          {t("ui.output")}
        </span>
      </div>
      {rows.map((row) => (
        <div className="chart-row" key={row.label}>
          <span className="chart-label" title={row.label}>
            {row.label}
          </span>
          <svg
            viewBox="0 0 480 24"
            preserveAspectRatio="none"
            role="img"
            aria-label={t("text.tokenChart", { name: row.label, input: row.input, output: row.output })}
          >
            <rect width="480" height="24" rx="3" className="chart-track" />
            <rect
              width={(row.input / max) * 480}
              height="24"
              rx="3"
              className="chart-input"
            />
            <rect
              x={(row.input / max) * 480}
              width={(row.output / max) * 480}
              height="24"
              className="chart-output"
            />
          </svg>
          <span className="mono muted">{number(row.input + row.output)}</span>
        </div>
      ))}
    </div>
  );
}
export function Usage() {
  const { t, formatDuration: duration, formatNumber, formatDate, locale } = useI18n();
  const number = (value: number) => formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const [group, setGroup] = useState<"agent" | "model" | "day">("agent");
  const rows = useMemo(() => {
    const grouped = new Map<string, Row>();
    for (const entry of usage.data?.entries ?? []) {
        const label = group === "day" ? entry.startedAt.slice(0, 10) : group === "model" ? entry.model : entry.agentName;
        const row = grouped.get(label) ?? {
          label,
          input: 0,
          output: 0,
          durationMs: 0,
        };
        row.input += entry.tokensIn;
        row.output += entry.tokensOut;
        row.durationMs += entry.durationMs;
        grouped.set(label, row);
      }
    return [...grouped.values()].sort((a, b) =>
      group === "day"
        ? a.label.localeCompare(b.label)
        : b.input + b.output - (a.input + a.output),
    ).map((row) => group === "day" ? { ...row, label: formatDate(`${row.label}T00:00:00Z`, { dateStyle: "medium", timeZone: "UTC" }) } : row);
  }, [usage.data, group, locale]);
  const summary = usage.data;
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>{t("ui.usage")}</h1>
        <span className="muted">{t("ui.allTime")}</span>
      </header>
      <div className="page-content usage-page">
        <ErrorNotice error={usage.error} />
        {usage.isPending ? (
          <Loading />
        ) : (
          <div className="stats-grid">
            {[
              {
                label: t("ui.totalTokens"),
                value: number(
                  (summary?.tokensIn ?? 0) + (summary?.tokensOut ?? 0),
                ),
                detail: t("text.tokenDetail", { input: summary?.tokensIn ?? 0, output: summary?.tokensOut ?? 0 }),
              },
              {
                label: t("ui.runTime"),
                value: duration(summary?.durationMs ?? 0),
                detail: t("ui.acrossAllBuilds"),
              },
              {
                label: t("ui.builds"),
                value: number(summary?.builds ?? 0),
                detail: t("count.turns", { count: summary?.turns ?? 0 }),
              },
            ].map((stat) => (
              <div className="stat-card" key={stat.label}>
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
                <small>{stat.detail}</small>
              </div>
            ))}
          </div>
        )}
        <section className="usage-section">
          <div className="section-heading">
            <h3>
              <BarChart3 size={15} />
              {t("text.tokensBy", { group: t(`group.${group}`) })}
            </h3>
            <div className="tabs">
              {(["agent", "model", "day"] as const).map((value) => (
                <button
                  className={value === group ? "active" : ""}
                  key={value}
                  onClick={() => setGroup(value)}
                >
                  {t(`group.${value}`)}
                </button>
              ))}
            </div>
          </div>
          <p className="hint usage-explainer">
            {t("ui.completedTurnsIncludingChiefAgentAndModelReflectEachTurnWhenItRanDaysUseUTCStartDates")}
          </p>
          <ErrorNotice error={usage.error} />
          {usage.isPending ? (
            <Loading />
          ) : rows.length ? (
            <TokenChart rows={rows} />
          ) : (
            <Empty
              icon={<BarChart3 size={26} />}
              title={t("ui.theWorkWillAddUpHere")}
            >
              {t("ui.startYourFirstTaskToSeeUsage")}
            </Empty>
          )}
        </section>
        {!!rows.length && (
          <section className="usage-section">
            <div className="section-heading">
              <h3>
                <Clock3 size={15} />
                {t("text.durationsBy", { group: t(`group.${group}`) })}
              </h3>
            </div>
            <div className="duration-list">
              {rows.map((row) => (
                <div key={row.label}>
                  <span>{row.label}</span>
                  <span className="mono muted">{duration(row.durationMs)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
