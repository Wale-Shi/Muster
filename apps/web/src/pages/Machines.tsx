import { useI18n } from "../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Monitor, Server } from "lucide-react";
import type { Machine } from "@muster/shared";
import { api } from "../api/client";
import { Empty, ErrorNotice, Loading } from "../components/ui";

function MachineCard({ machine }: { machine: Machine }) {
  const { t, label, formatDate, formatNumber } = useI18n();
  const [concurrency, setConcurrency] = useState(
    Math.min(10, machine.concurrency),
  );
  const client = useQueryClient();
  useEffect(
    () => setConcurrency(Math.min(10, machine.concurrency)),
    [machine.concurrency],
  );
  const update = useMutation({
    mutationFn: () => api.updateMachine(machine.id, concurrency),
    onSuccess: () => client.invalidateQueries({ queryKey: ["machines"] }),
  });
  return (
    <article className="machine-card">
      <div className="machine-top">
        <span className="machine-icon">
          <Monitor size={21} />
        </span>
        <div>
          <h3>{machine.name}</h3>
          <span className="muted">
            <span className={`status-dot ${machine.online ? "online" : ""}`} />
            {machine.online ? t("ui.online") : t("ui.offline")}
          </span>
        </div>
        <span className="badge mono">
          {t("count.running", { count: machine.running ?? 0 })}
        </span>
      </div>
      <div className="machine-runtimes">
        {machine.runtimes.map((runtime) => (
          <span className="badge" key={label("runtime", runtime)}>
            <Cpu size={12} />
            {label("runtime", runtime)}
          </span>
        ))}
      </div>
      <div className="concurrency-label">
        <label htmlFor={`concurrency-${machine.id}`}>{t("ui.concurrency")}</label>
        <span className="mono">{formatNumber(concurrency)}</span>
      </div>
      <input
        id={`concurrency-${machine.id}`}
        type="range"
        min={1}
        max={10}
        value={concurrency}
        onChange={(event) => setConcurrency(Number(event.target.value))}
      />
      <div className="row concurrency-footer">
        <span className="hint">
          {machine.concurrency > 10
            ? t("text.limit", { current: machine.concurrency, next: concurrency })
            : t("ui.maximumSimultaneousTurns")}
        </span>
        <button
          className="button"
          disabled={update.isPending || concurrency === machine.concurrency}
          onClick={() => update.mutate()}
        >
          {update.isPending ? t("ui.saving") : t("ui.save")}
        </button>
      </div>
      <ErrorNotice error={update.error} />
      <div className="machine-seen hint">
        {machine.lastSeenAt
          ? t("text.lastSeen", { date: formatDate(machine.lastSeenAt) })
          : t("ui.noHeartbeatYet")}
      </div>
    </article>
  );
}
export function Machines() {
  const { t } = useI18n();
  const machines = useQuery({
    queryKey: ["machines"],
    queryFn: api.machines,
    refetchInterval: 10_000,
  });
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>{t("ui.machines")}</h1>
        <span className="muted">
          {t("count.online", { count: machines.data?.filter((machine) => machine.online).length ?? 0 })}
        </span>
      </header>
      <div className="page-content">
        <div className="page-intro">
          <h2>{t("ui.putYourMachinesToWork")}</h2>
          <p>{t("ui.connectedMachinesPickUpTasksAndRunYourAgentsLocally")}</p>
        </div>
        <ErrorNotice error={machines.error} />
        {machines.isPending ? (
          <Loading />
        ) : !machines.data?.length ? (
          <Empty icon={<Server size={28} />} title={t("ui.noMachinesConnected")}>
            <span>{t("ui.startADaemonToConnectYourFirstMachine")}</span>
            <code className="command-block">
              muster-daemon start --server http://localhost:7420
            </code>
          </Empty>
        ) : (
          <div className="machine-grid">
            {machines.data.map((machine) => (
              <MachineCard key={machine.id} machine={machine} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
