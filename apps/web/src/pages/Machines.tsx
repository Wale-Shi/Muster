import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Monitor, Server } from "lucide-react";
import type { Machine } from "@muster/shared";
import { api } from "../api/client";
import { Empty, ErrorNotice, Loading } from "../components/ui";

function MachineCard({ machine }: { machine: Machine }) {
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
            {machine.online ? "Online" : "Offline"}
          </span>
        </div>
        <span className="badge mono">
          {machine.running ?? 0} running{" "}
          {(machine.running ?? 0) === 1 ? "turn" : "turns"}
        </span>
      </div>
      <div className="machine-runtimes">
        {machine.runtimes.map((runtime) => (
          <span className="badge" key={runtime}>
            <Cpu size={12} />
            {runtime}
          </span>
        ))}
      </div>
      <div className="concurrency-label">
        <label htmlFor={`concurrency-${machine.id}`}>Concurrency</label>
        <span className="mono">{concurrency}</span>
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
            ? `Current machine limit: ${machine.concurrency}. Save to apply ${concurrency}.`
            : "Maximum simultaneous turns"}
        </span>
        <button
          className="button"
          disabled={update.isPending || concurrency === machine.concurrency}
          onClick={() => update.mutate()}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      <ErrorNotice error={update.error} />
      <div className="machine-seen hint">
        {machine.lastSeenAt
          ? `Last seen ${new Date(machine.lastSeenAt).toLocaleString()}`
          : "No heartbeat yet"}
      </div>
    </article>
  );
}
export function Machines() {
  const machines = useQuery({
    queryKey: ["machines"],
    queryFn: api.machines,
    refetchInterval: 10_000,
  });
  return (
    <div className="management-page">
      <header className="page-header">
        <h1>Machines</h1>
        <span className="muted">
          {machines.data?.filter((machine) => machine.online).length ?? 0}{" "}
          online
        </span>
      </header>
      <div className="page-content">
        <div className="page-intro">
          <h2>Put your machines to work.</h2>
          <p>Connected machines pick up tasks and run your agents locally.</p>
        </div>
        <ErrorNotice error={machines.error} />
        {machines.isPending ? (
          <Loading />
        ) : !machines.data?.length ? (
          <Empty icon={<Server size={28} />} title="No machines connected">
            <span>Start a daemon to connect your first machine.</span>
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
