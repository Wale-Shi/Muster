import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { TurnJob } from "@muster/shared";
import { safeId } from "./util.js";

// Kept outside the worktree: checkpoints and read-only cleanup must not remove deliverables.
export async function prepareArtifacts(job: TurnJob, home: string): Promise<TurnJob> {
  if (!job.todoId || !job.project || job.kind === "merge") return job;
  const root = await realpath(home);
  let directory = root;
  for (const part of ["artifacts", safeId(job.buildId)]) {
    directory = join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error("Unsafe artifact directory");
  }
  return { ...job, systemInstructions: job.systemInstructions + `\n\nBuild artifact directory: ${JSON.stringify(directory)}\nSave screenshots and other deliverables in this directory. If a tool writes a temporary file, copy it here before referencing it. Use a unique filename for each revision. Reference images with Markdown, for example ![Screenshot](<${directory}/screenshot.png>). Only png/jpg/jpeg/gif/webp up to 10 MiB can be displayed. Files in /tmp cannot be displayed.\n` };
}
