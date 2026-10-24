import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

export function mergePath(shellPath: string, inherited: string, home: string, separator = delimiter): string {
  const extra = separator === ";" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local/bin"), join(home, ".npm-global/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set([...shellPath.split(separator), ...inherited.split(separator), ...extra].map((p) => p.trim()).filter((p) => p && (separator === ";" ? /^[a-z]:[\\/]/i.test(p) : p.startsWith("/"))))].join(separator);
}

export async function resolvePath(env = process.env, platform = process.platform): Promise<string> {
  if (platform === "win32") return mergePath("", env.PATH ?? env.Path ?? "", homedir(), ";");
  // Markers discard prompts, MOTDs and shell startup chatter. Never interpolate user input.
  const output = await new Promise<string>((resolve) => {
    execFile(env.SHELL || "/bin/zsh", ["-ilc", "printf '\\n__MUSTER_PATH_BEGIN__%s__MUSTER_PATH_END__\\n' \"$PATH\""],
      { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
  return mergePath(output.match(/__MUSTER_PATH_BEGIN__(.*?)__MUSTER_PATH_END__/s)?.[1] ?? "", env.PATH ?? "", homedir());
}
