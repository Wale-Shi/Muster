import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, CHOKIDAR_USEPOLLING: process.env.CHOKIDAR_USEPOLLING ?? "true" };
const children = [
  spawn(process.execPath, [fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)), "watch", "apps/server/src/index.ts"], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--host", "127.0.0.1"], { cwd: fileURLToPath(new URL("../apps/web", import.meta.url)), env, stdio: "inherit" }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  Promise.all(children.map((child) => child.exitCode !== null ? undefined : new Promise((resolve) => child.once("exit", resolve)))).then(() => process.exit(code));
};
for (const child of children) {
  child.once("error", (error) => { console.error(error); stop(1); });
  child.once("exit", (code) => { if (!stopping) stop(code ?? 1); });
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
