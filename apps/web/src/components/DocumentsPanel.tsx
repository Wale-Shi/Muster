import { useI18n } from "../i18n";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, FileText, Search } from "lucide-react";
import type { Document, DocumentKind } from "@muster/shared";
import { api, type TodoDetail } from "../api/client";
import { parseDiff } from "../lib/diff";
import { Markdown } from "./Conversation";
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

export function DocumentsPanel({ todo }: { todo: TodoDetail }) {
  const { t } = useI18n();
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
            {t("ui.plan")}
          </button>
          <button
            className={tab === "changes" ? "active" : ""}
            onClick={() => setTab("changes")}
          >
            <FileCode2 size={14} />
            {t("ui.changes")}
          </button>
        </div>
        <select
          aria-label={t("ui.documentVersion")}
          value={selected?.id ?? ""}
          disabled={!versions.length}
          onChange={(event) =>
            setSelection((prior) => ({ ...prior, [tab]: event.target.value }))
          }
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
          <Empty
            icon={
              tab === "plan" ? <FileText size={26} /> : <FileCode2 size={26} />
            }
            title={tab === "plan" ? t("ui.aPlanStartsHere") : t("ui.noChangesYet")}
          >
            {tab === "plan"
              ? t("ui.theAgentsPlanWillAppearHereForYourReview")
              : t("ui.completedBuildsWillIncludeADiffOfEveryChangedFile")}
          </Empty>
        ) : tab === "plan" ? (
          <div className="plan-content">
            <div className="document-eyebrow">
              {t("text.planVersion", { version: selected.version })}
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
