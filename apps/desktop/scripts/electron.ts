import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

async function installElectron(directory: string): Promise<void> {
  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(directory, "install.js")], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`installer exited with ${code ?? signal}`)));
  });
}

/** npm installations that skip lifecycle scripts still need Electron's downloaded executable. */
export async function ensureElectron(root: string, install = installElectron): Promise<string> {
  const directory = join(root, "node_modules/electron");
  const executable = async () => {
    const path = (await readFile(join(directory, "path.txt"), "utf8")).trim();
    if (!path) throw new Error("Electron path.txt is empty");
    const binary = join(directory, "dist", path);
    await access(binary);
    return binary;
  };
  try { return await executable(); } catch { /* Install missing or incomplete binary. */ }
  console.log("Electron binary is missing; downloading it with electron/install.js...");
  try { await install(directory); return await executable(); }
  catch (error) {
    throw new Error(`Electron binary download failed. Check network/proxy access and retry: node ${join(directory, "install.js")}`, { cause: error });
  }
}
