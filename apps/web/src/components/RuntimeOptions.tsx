import { RUNTIMES } from "@muster/shared";
import { useMachines } from "../api/queries";
import { useI18n } from "../i18n";

/** Runtime <option>s, with runtimes an enrolled machine reported listed first. */
export function RuntimeOptions() {
  const { t, label } = useI18n();
  const machines = useMachines();
  const installed = new Set(machines.data?.flatMap((machine) => machine.runtimes) ?? []);
  const option = (id: string) => <option key={id} value={id}>{id === "mock" ? t("ui.mockLocalTest") : label("runtime", id)}</option>;
  const ids = RUNTIMES.map((runtime) => runtime.id as string);
  if (!machines.data) return <>{ids.map(option)}</>;
  return <>
    <optgroup label={t("ui.runtimeInstalled")}>{ids.filter((id) => installed.has(id as never)).map(option)}</optgroup>
    <optgroup label={t("ui.runtimeNotDetected")}>{ids.filter((id) => !installed.has(id as never)).map(option)}</optgroup>
  </>;
}
