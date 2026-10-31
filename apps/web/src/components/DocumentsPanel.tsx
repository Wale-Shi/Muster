import { useI18n } from "../i18n";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, Search } from "lucide-react";
import type { Document } from "@muster/shared";
import { api, type TodoDetail } from "../api/client";
import { parseDiff } from "../lib/diff";
import { Empty, ErrorNotice, Loading } from "./ui";

export function DiffView({ content }: { content: string }) {
  const { t, formatNumber } = useI18n();
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
          {t("count.files", { count: files.length })}
        </span>
        <span className="diff-add">+{formatNumber(added)}</span>
        <span className="diff-remove">−{formatNumber(removed)}</span>
      </div>
      <label className="file-filter">
        <Search size={13} />
        <input
          aria-label={t("ui.filterChangedFiles")}
          placeholder={t("ui.filterFiles")}
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
            <span className="diff-add">+{formatNumber(file.added)}</span>
            <span className="diff-remove">−{formatNumber(file.removed)}</span>
          </summary>
          {file.previousPath &&
            file.previousPath !== file.path &&
            file.previousPath !== "/dev/null" && (
              <p className="hint rename-path">
                {t("text.renamed", { path: file.previousPath })}
              </p>
            )}
          {file.binary ? (
            <p className="hint binary-notice">{t("ui.binaryFileChanged")}</p>
          ) : (
            <div
              className="diff-code"
              role="region"
              aria-label={t("text.diff", { path: file.path })}
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
          title={filter ? t("ui.noMatchingFiles") : t("ui.noChangesYet")}
        >
          {filter
            ? t("ui.tryAnotherFileName")
            : content.trim()
              ? t("ui.noUnifiedDiffWasProvidedByTheRuntime")
              : t("ui.changesWillAppearAfterTheAgentFinishesABuild")}
        </Empty>
      )}
    </div>
  );
}

/** The task's diff, one version per completed build or revision. */
export function DocumentsPanel({ todo }: { todo: TodoDetail }) {
  const { t } = useI18n();
  const [selection, setSelection] = useState("");
  const documents = useQuery({
    queryKey: ["documents", todo.id],
    queryFn: () => api.documents(todo.id),
  });
  const available = documents.data ?? todo.builds.flatMap((build) => build.documents);
  const buildOrder = new Map(todo.builds.map((build, i) => [build.id, i]));
  const versions = available
    .filter((document) => document.kind === "changes")
    .sort(
      (a, b) =>
        (buildOrder.get(b.buildId) ?? 0) - (buildOrder.get(a.buildId) ?? 0) ||
        b.version - a.version,
    );
  const selected: Document | undefined = versions.find((document) => document.id === selection) ?? versions[0];
  return (
    <div className="documents-panel">
      <div className="document-header">
        <div className="tabs">
          <button className="active">
            <FileCode2 size={14} />
            {t("ui.changes")}
          </button>
        </div>
        <select
          aria-label={t("ui.documentVersion")}
          value={selected?.id ?? ""}
          disabled={!versions.length}
          onChange={(event) => setSelection(event.target.value)}
        >
          {!versions.length && <option>{t("ui.noVersions")}</option>}
          {versions.map((document) => (
            <option value={document.id} key={document.id}>
              {t("text.version", { build: (buildOrder.get(document.buildId) ?? 0) + 1, version: document.version })}
            </option>
          ))}
        </select>
      </div>
      <div className="document-scroll">
        <ErrorNotice error={documents.error} />
        {documents.isPending ? (
          <Loading />
        ) : !selected ? (
          <Empty icon={<FileCode2 size={26} />} title={t("ui.noChangesYet")}>
            {t("ui.completedBuildsWillIncludeADiffOfEveryChangedFile")}
          </Empty>
        ) : (
          <DiffView content={selected.content} />
        )}
      </div>
    </div>
  );
}
