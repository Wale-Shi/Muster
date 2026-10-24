export interface DiffLine {
  kind: "add" | "remove" | "context" | "hunk" | "meta";
  text: string;
  old: number | null;
  next: number | null;
}
export interface DiffFile {
  path: string;
  previousPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}
const unquote = (path: string) => {
  try {
    return path.startsWith('"') ? String(JSON.parse(path)) : path;
  } catch {
    return path;
  }
};
const cleanPath = (path: string) => unquote(path).replace(/^[ab]\//, "");

export function parseDiff(content: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const text of content.replace(/\r\n/g, "\n").split("\n")) {
    if (text.startsWith("diff --git ")) {
      const match = /^diff --git (".*?"|a\/.*?) (".*"|b\/.*)$/.exec(text);
      file = {
        path: cleanPath(match?.[2] ?? text.slice(11)),
        previousPath: null,
        added: 0,
        removed: 0,
        binary: false,
        lines: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file && text.startsWith("--- ")) {
      file = {
        path: cleanPath(text.slice(4)),
        previousPath: null,
        added: 0,
        removed: 0,
        binary: false,
        lines: [],
      };
      files.push(file);
    }
    if (!file) continue;
    if (!inHunk && text.startsWith("--- ")) {
      file.previousPath = cleanPath(text.slice(4));
      continue;
    }
    if (!inHunk && text.startsWith("+++ ")) {
      const path = cleanPath(text.slice(4));
      file.path =
        path === "/dev/null" ? (file.previousPath ?? file.path) : path;
      continue;
    }
    if (text.startsWith("rename from "))
      file.previousPath = unquote(text.slice(12));
    if (text.startsWith("rename to ")) file.path = unquote(text.slice(10));
    if (text.startsWith("Binary files ") || text === "GIT binary patch")
      file.binary = true;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", text, old: null, next: null });
    } else if (inHunk && text.startsWith("+")) {
      file.added++;
      file.lines.push({ kind: "add", text, old: null, next: next++ });
    } else if (inHunk && text.startsWith("-")) {
      file.removed++;
      file.lines.push({ kind: "remove", text, old: old++, next: null });
    } else if (inHunk && text.startsWith(" ")) {
      file.lines.push({ kind: "context", text, old: old++, next: next++ });
    } else if (text)
      file.lines.push({ kind: "meta", text, old: null, next: null });
  }
  return files;
}
