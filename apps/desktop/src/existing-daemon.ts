import { readFileSync } from "node:fs";
import { join } from "node:path";

// The CLI and desktop share a lock/registration. Never start two claim loops for one machine.
export function existingDaemon(home: string, origin: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(join(home, "daemon.lock/pid"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid daemon lock; check it before removing it");
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  const registration = JSON.parse(readFileSync(join(home, "machine.json"), "utf8")) as { server: string };
  if (registration.server !== origin) throw new Error(`This machine's daemon is already connected to ${registration.server}. Stop it before connecting to ${origin}.`);
  return true;
}
