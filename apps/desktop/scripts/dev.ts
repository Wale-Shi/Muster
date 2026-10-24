import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectron } from "./electron.js";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = await ensureElectron(resolve(desktop, "../.."));
const child = spawn(binary, [".", ...process.argv.slice(2)], { cwd: desktop, stdio: "inherit" });
child.once("error", (error) => { console.error(error); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
