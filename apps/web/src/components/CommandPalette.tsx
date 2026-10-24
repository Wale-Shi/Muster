import { useI18n } from "../i18n";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight, Hash, MessageSquare, Search } from "lucide-react";
import { useTodos, useTopics } from "../api/queries";
import { Dialog, ErrorNotice } from "./ui";

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const todos = useTodos();
  const topics = useTopics();
  const navigate = useNavigate();
  const tabs = [t("ui.all"), t("ui.tasks"), t("ui.topics")];
  const results = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [
      ...(tab !== 2
        ? (todos.data ?? [])
            .filter((todo) =>
              `${todo.title} #${todo.number} ${todo.spec}`
                .toLowerCase()
                .includes(query),
            )
            .map((todo) => ({
              id: todo.id,
              title: todo.title,
              subtitle: `#${todo.number}`,
              href: `/todos/${todo.id}`,
              kind: "task",
            }))
        : []),
      ...(tab !== 1
        ? (topics.data ?? [])
            .filter((topic) => topic.title.toLowerCase().includes(query))
            .map((topic) => ({
              id: topic.id,
              title: topic.title,
              subtitle: t("ui.topic"),
              href: `/topics/${topic.id}`,
              kind: "topic",
            }))
        : []),
    ].slice(0, 30);
  }, [todos.data, topics.data, search, tab, t]);
  const open = (href: string) => {
    void navigate(href);
    onClose();
  };
  return (
    <Dialog title={t("ui.searchWorkspace")} onClose={onClose} wide>
      <div
        className="command-palette"
        onKeyDown={(event) => {
          if (
            event.key === "Tab" &&
            !(event.metaKey || event.ctrlKey || event.altKey)
          ) {
            event.preventDefault();
            setTab((current) => (current + (event.shiftKey ? 2 : 1)) % 3);
            setSelected(0);
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((current) =>
              Math.max(
                0,
                Math.min(
                  results.length - 1,
                  current + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
          }
          if (
            event.key === "Enter" &&
            results[selected] &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            open(results[selected].href);
          }
        }}
      >
        <label className="command-search">
          <Search size={18} />
          <input
            autoFocus
            aria-label={t("ui.searchTasksAndTopics")}
            placeholder={t("ui.searchPlaceholder")}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected(0);
            }}
          />
        </label>
        <div className="command-tabs">
          {tabs.map((name, index) => (
            <button
              key={name}
              className={tab === index ? "active" : ""}
              onClick={() => {
                setTab(index);
                setSelected(0);
              }}
            >
              {name}
            </button>
          ))}
          <kbd>tab</kbd>
        </div>
        <ErrorNotice error={todos.error || topics.error} />
        <div
          className="command-results"
          role="listbox"
          aria-label={t("ui.searchResults")}
        >
          {results.map((result, index) => (
            <button
              role="option"
              aria-selected={index === selected}
              className={index === selected ? "selected" : ""}
              key={result.id}
              onMouseMove={() => setSelected(index)}
              onClick={() => open(result.href)}
            >
              {result.kind === "task" ? (
                <Hash size={15} />
              ) : (
                <MessageSquare size={15} />
              )}
              <span>{result.title}</span>
              <small>{result.subtitle}</small>
              <ArrowUpRight size={13} />
            </button>
          ))}
          {!results.length && (
            <div className="empty">
              <p>
                {todos.isPending || topics.isPending
                  ? t("ui.searching")
                  : t("ui.noResultsFound")}
              </p>
            </div>
          )}
        </div>
        <div className="command-help">
          <span>{t("ui.navigate")}</span>
          <span>{t("ui.open")}</span>
          <span>{t("ui.escClose")}</span>
        </div>
      </div>
    </Dialog>
  );
}
