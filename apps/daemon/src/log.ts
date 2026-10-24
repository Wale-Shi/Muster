import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "./util.js";
export type Logger = (level: "info" | "error", message: string, fields?: Record<string, unknown>) => void;
export function createLogger(home: string): Logger {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return (level, message, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }) + "\n";
    process.stdout.write(line);
    try { appendFileSync(join(home, "daemon.log"), line, { mode: 0o600 }); }
    catch (error) { process.stderr.write(`Cannot write daemon log: ${errorText(error)}\n`); }
  };
}
