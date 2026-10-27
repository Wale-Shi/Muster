import { useI18n } from "../i18n";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cpu, Server } from "lucide-react";
import type { Machine } from "@muster/shared";
import { useMachines } from "../api/queries";
import { api } from "../api/client";
import { Empty, ErrorNotice, Loading, Section, SettingRow } from "../components/ui";

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
  return <SettingRow label={machine.name} help={<><span className={`status-dot ${machine.online ? "online" : ""}`} /> {machine.online ? t("ui.online") : t("ui.offline")} · {t("count.running", { count: machine.running ?? 0 })}<br />{machine.runtimes.map((runtime) => <span className="badge" key={runtime}><Cpu size={12} /> {label("runtime", runtime)}</span>)}<br />{machine.lastSeenAt ? t("text.lastSeen", { date: formatDate(machine.lastSeenAt) }) : t("ui.noHeartbeatYet")}</>}><div className="machine-control"><label htmlFor={`concurrency-${machine.id}`}>{t("ui.concurrency")}: {formatNumber(concurrency)}</label><input id={`concurrency-${machine.id}`} type="range" min={1} max={10} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /><span className="hint">{machine.concurrency > 10 ? t("text.limit", { current: machine.concurrency, next: concurrency }) : t("ui.maximumSimultaneousTurns")}</span><button className="button" disabled={update.isPending || concurrency === machine.concurrency} onClick={() => update.mutate()}>{update.isPending ? t("ui.saving") : t("ui.save")}</button><ErrorNotice error={update.error} /></div></SettingRow>;

}
export function Machines() {
  const { t } = useI18n();
  const machines = useMachines();
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>{t("ui.machines")}</h1>
        <span className="muted">
          {t("count.online", { count: machines.data?.filter((machine) => machine.online).length ?? 0 })}
        </span>
      </header>
      <div className="page-content">
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
          <Section title={t("ui.machines")}>
            {machines.data.map((machine) => (
              <MachineCard key={machine.id} machine={machine} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
