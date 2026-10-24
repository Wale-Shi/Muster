import type { Locale } from "@muster/shared";
// The packaged main process has no node_modules, so only types may come from @muster/shared; keep in sync with packages/shared/src/locale.ts.
export const isLocale = (value: unknown): value is Locale => value === "en" || value === "zh-CN";
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages.map((value) => value.toLowerCase())) {
    if (language.startsWith("zh")) return "zh-CN";
    if (language.startsWith("en")) return "en";
  }
  return "en";
}
const en = {
  lock: "Invalid daemon lock; check it before removing it", port: "No free local port for Muster", ready: "Muster server did not become ready; see server.log", serverExit: "Server exited ({code}); see server.log", otherServer: "This machine's daemon is already connected to {server}. Stop it before connecting to {origin}.",
  file: "File", edit: "Edit", view: "View", window: "Window", newTask: "New task", browser: "Open in browser", logs: "Show logs", folder: "Choose project repository", open: "Open Muster", connecting: "Machine connecting", online: "Machine online", offline: "Machine offline", running: "{count} running", confirm: "Needs confirmation", review: "Needs review", failed: "Task failed", workerStopped: "Muster worker stopped", workerError: "{name} exited unexpectedly. See {logs}", startup: "Muster could not start", startupError: "{error}\nLogs: {logs}", server: "Server", daemon: "Daemon", untrusted: "Untrusted desktop request", path: "Expected a local absolute path", invalidLocale: "Unsupported language",
} as const;
type Messages = { [K in keyof typeof en]: string };
const dictionaries: Record<Locale, Messages> = {
  en,
  "zh-CN": { lock: "守护进程锁文件无效，请先检查再决定是否删除", port: "没有可供 Muster 使用的本地端口", ready: "Muster 服务器未能就绪，请查看 server.log", serverExit: "服务器已退出（{code}），请查看 server.log", otherServer: "这台机器的守护进程已连接到 {server}。请先停止它，再连接到 {origin}。", file: "文件", edit: "编辑", view: "视图", window: "窗口", newTask: "新建任务", browser: "在浏览器中打开", logs: "查看日志", folder: "选择项目仓库", open: "打开 Muster", connecting: "机器连接中", online: "机器在线", offline: "机器离线", running: "{count} 轮运行中", confirm: "需要确认", review: "需要评审", failed: "任务失败", workerStopped: "Muster 后台进程已停止", workerError: "{name} 意外退出。日志位于 {logs}", startup: "Muster 无法启动", startupError: "{error}\n日志：{logs}", server: "服务器", daemon: "守护进程", untrusted: "不受信任的桌面请求", path: "请提供本地绝对路径", invalidLocale: "不支持此语言" },
};
export function desktopText(locale: Locale, key: keyof Messages, params: Record<string, string | number> = {}) {
  return dictionaries[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => typeof params[name] === "number" ? new Intl.NumberFormat(locale).format(params[name]) : params[name] ?? match);
}
export function notificationTitle(locale: Locale, phase: string) {
  return `${desktopText(locale, phase === "confirm" ? "confirm" : phase === "review" ? "review" : "failed")} · Muster`;
}

export function desktopError(locale: Locale, error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  for (const key of ["lock", "port", "ready"] as const) if (text === en[key]) return desktopText(locale, key);
  const exit = text.match(/^Server exited \((.+)\); see server\.log$/);
  if (exit) return desktopText(locale, "serverExit", { code: exit[1]! });
  const connected = text.match(/^This machine's daemon is already connected to (.+)\. Stop it before connecting to (.+)\.$/);
  return connected ? desktopText(locale, "otherServer", { server: connected[1]!, origin: connected[2]! }) : text;
}
