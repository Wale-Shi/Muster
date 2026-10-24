// Keep the user's shell, credentials and desktop-resolved PATH, but never pass
// worker bootstrap settings into agents (or the commands they launch).
const workerOnly = new Set(["NODE_ENV", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);

export function runtimeEnv(userEnv: NodeJS.ProcessEnv = process.env, grantedSecrets: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // No MUSTER_* variables are needed: MCP credentials/config go through the
  // runtime protocol. Filter grants too so they cannot restore worker settings.
  return Object.fromEntries(Object.entries({ ...userEnv, ...grantedSecrets }).filter(([key, value]) =>
    value !== undefined && !workerOnly.has(key.toUpperCase()) && !/^(MUSTER_|ELECTRON_)/i.test(key),
  ));
}
