import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, FileText, Search } from "lucide-react";
import type { Document, DocumentKind } from "@muster/shared";
import { api, type TodoDetail } from "../api/client";
import { parseDiff } from "../lib/diff";
import { Markdown } from "./Conversation";
import { Empty, ErrorNotice, Loading } from "./ui";

export function DiffView({ content }: { content: string }) {
  const [filter, setFilter] = useState("");
  const files = useMemo(() => parseDiff(content), [content]);
  const visible = files.filter((file) =>
    file.path.toLowerCase().includes(filter.toLowerCase()),
  );
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="diff-add">+{added}</span>
        <span className="diff-remove">−{removed}</span>
      </div>
      <label className="file-filter">
        <Search size={13} />
        <input
          aria-label="Filter changed files"
          placeholder="Filter files…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      {visible.map((file, index) => (
        <details className="diff-file" key={`${file.path}-${index}`} open>
          <summary>
            <FileCode2 size={13} />
            <span className="mono diff-path" title={file.path}>
              {file.path}
            </span>
            <span className="diff-add">+{file.added}</span>
            <span className="diff-remove">−{file.removed}</span>
          </summary>
          {file.previousPath &&
            file.previousPath !== file.path &&
            file.previousPath !== "/dev/null" && (
              <p className="hint rename-path">
                Renamed from {file.previousPath}
              </p>
            )}
          {file.binary ? (
            <p className="hint binary-notice">Binary file changed</p>
          ) : (
            <div
              className="diff-code"
              role="region"
              aria-label={`Diff for ${file.path}`}
              tabIndex={0}
            >
              {file.lines.map((line, i) => (
                <div key={i} className={`diff-line ${line.kind}`}>
                  <span className="line-number">{line.old}</span>
                  <span className="line-number">{line.next}</span>
                  <code>{line.text || " "}</code>
                </div>
              ))}
            </div>
          )}
        </details>
      ))}
      {!visible.length && (
        <Empty
          icon={<FileCode2 size={24} />}
          title={filter ? "No matching files" : "No changes yet"}
        >
          {filter
            ? "Try another file name."
            : content.trim()
              ? "No unified diff was provided by the runtime."
              : "Changes will appear after the agent finishes a build."}
        </Empty>
      )}
    </div>
  );
}

export function DocumentsPanel({ todo }: { todo: TodoDetail }) {
  const [chosenTab, setTab] = useState<DocumentKind | null>(null);
  const [selection, setSelection] = useState<Record<DocumentKind, string>>({
    plan: "",
    changes: "",
  });
  const documents = useQuery({
    queryKey: ["documents", todo.id],
    queryFn: () => api.documents(todo.id),
  });
  const available = documents.data ?? todo.builds.flatMap((build) => build.documents);
  const tab = chosenTab ?? (available.some((document) => document.kind === "plan")
    ? "plan" : available.some((document) => document.kind === "changes") ? "changes" : "plan");
  const buildOrder = new Map(todo.builds.map((build, i) => [build.id, i]));
  const versions = available
    .filter((document) => document.kind === tab)
    .sort(
      (a, b) =>
        (buildOrder.get(b.buildId) ?? 0) - (buildOrder.get(a.buildId) ?? 0) ||
        b.version - a.version,
    );
  const selected: Document | undefined =
    versions.find((document) => document.id === selection[tab]) ?? versions[0];
  return (
    <div className="documents-panel">
      <div className="document-header">
        <div className="tabs">
          <button
            className={tab === "plan" ? "active" : ""}
            onClick={() => setTab("plan")}
          >
            <FileText size={14} />
            Plan
          </button>
          <button
            className={tab === "changes" ? "active" : ""}
            onClick={() => setTab("changes")}
          >
            <FileCode2 size={14} />
            Changes
          </button>
        </div>
        <select
          aria-label="Document version"
          value={selected?.id ?? ""}
          disabled={!versions.length}
          onChange={(event) =>
            setSelection((prior) => ({ ...prior, [tab]: event.target.value }))
          }
        >
          {!versions.length && <option>No versions</option>}
          {versions.map((document) => (
            <option value={document.id} key={document.id}>
              Build {(buildOrder.get(document.buildId) ?? 0) + 1} · v
              {document.version}
            </option>
          ))}
        </select>
      </div>
      <div className="document-scroll">
        <ErrorNotice error={documents.error} />
        {documents.isPending ? (
          <Loading />
        ) : !selected ? (
          <Empty
            icon={
              tab === "plan" ? <FileText size={26} /> : <FileCode2 size={26} />
            }
            title={tab === "plan" ? "A plan starts here" : "No changes yet"}
          >
            {tab === "plan"
              ? "The agent’s plan will appear here for your review."
              : "Completed builds will include a diff of every changed file."}
          </Empty>
        ) : tab === "plan" ? (
          <div className="plan-content">
            <div className="document-eyebrow">
              PLAN · VERSION {selected.version}
            </div>
            <Markdown>{selected.content}</Markdown>
          </div>
        ) : (
          <DiffView content={selected.content} />
        )}
      </div>
    </div>
  );
}
