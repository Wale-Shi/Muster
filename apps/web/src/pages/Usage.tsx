import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Clock3 } from "lucide-react";
import { api } from "../api/client";
import { useAgents, useTodos } from "../api/queries";
import { Empty, ErrorNotice, Loading } from "../components/ui";
import { duration, number } from "../lib/format";

type Row = { label: string; input: number; output: number; durationMs: number };
function TokenChart({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((row) => row.input + row.output));
  return (
    <div className="token-chart">
      <div className="chart-legend">
        <span>
          <i className="legend-input" />
          Input
        </span>
        <span>
          <i className="legend-output" />
          Output
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
            aria-label={`${row.label}: ${row.input} input and ${row.output} output tokens`}
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
  const usage = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  const todos = useTodos();
  const agents = useAgents();
  const ids = todos.data?.map((todo) => todo.id).sort() ?? [];
  const details = useQuery({
    queryKey: ["usage-details", ids],
    queryFn: () => Promise.all(ids.map((id) => api.todo(id))),
    enabled: todos.isSuccess,
  });
  const [group, setGroup] = useState<"agent" | "model" | "day">("agent");
  const rows = useMemo(() => {
    const grouped = new Map<string, Row>();
    for (const todo of details.data ?? [])
      for (const build of todo.builds) {
        const agent = agents.data?.find((item) => item.id === todo.agentId);
        const label =
          group === "day"
            ? build.createdAt.slice(0, 10)
            : group === "model"
              ? (agent?.model ?? "Unassigned")
              : (agent?.name ?? "Unassigned");
        const row = grouped.get(label) ?? {
          label,
          input: 0,
          output: 0,
          durationMs: 0,
        };
        row.input += build.tokensIn;
        row.output += build.tokensOut;
        row.durationMs += build.durationMs;
        grouped.set(label, row);
      }
    return [...grouped.values()].sort((a, b) =>
      group === "day"
        ? a.label.localeCompare(b.label)
        : b.input + b.output - (a.input + a.output),
    );
  }, [details.data, agents.data, group]);
  const summary = usage.data;
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>Usage</h1>
        <span className="badge">All time</span>
      </header>
      <div className="page-content usage-page">
        <div className="page-intro">
          <h2>A little perspective on the work.</h2>
          <p>Token usage and time across your workspace.</p>
        </div>
        <ErrorNotice error={usage.error || todos.error || agents.error} />
        {usage.isPending ? (
          <Loading />
        ) : (
          <div className="stats-grid">
            {[
              {
                label: "Total tokens",
                value: number(
                  (summary?.tokensIn ?? 0) + (summary?.tokensOut ?? 0),
                ),
                detail: `${number(summary?.tokensIn ?? 0)} input · ${number(summary?.tokensOut ?? 0)} output`,
              },
              {
                label: "Run time",
                value: duration(summary?.durationMs ?? 0),
                detail: "Across all builds",
              },
              {
                label: "Builds",
                value: summary?.builds ?? 0,
                detail: `${summary?.turns ?? 0} turns`,
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
              Tokens by {group}
            </h3>
            <div className="tabs">
              {(["agent", "model", "day"] as const).map((value) => (
                <button
                  className={value === group ? "active" : ""}
                  key={value}
                  onClick={() => setGroup(value)}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <p className="hint usage-explainer">
            Breakdowns use todo builds only; workspace totals also include
            Chief. Agent/model use current assignments; days use build start
            dates.
          </p>
          <ErrorNotice error={details.error} />
          {details.isPending ? (
            <Loading />
          ) : rows.length ? (
            <TokenChart rows={rows} />
          ) : (
            <Empty
              icon={<BarChart3 size={26} />}
              title="The work will add up here"
            >
              Start your first task to see usage.
            </Empty>
          )}
        </section>
        {!!rows.length && (
          <section className="usage-section">
            <div className="section-heading">
              <h3>
                <Clock3 size={15} />
                Run durations by {group}
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
