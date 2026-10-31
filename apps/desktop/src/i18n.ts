// The desktop app speaks Chinese. English strings are only the internal errors it translates.
const errors = { lock: "Invalid daemon lock; check it before removing it", port: "No free local port for Muster", ready: "Muster server did not become ready; see server.log" } as const;
const messages = {
  installRequired: "请先将 Muster 安装到应用程序目录", moveApp: "移至应用程序", quitApp: "退出", manualInstall: "未能移动应用。如果目标已存在，请退出该实例并手动更新。现有安装未被替换。",
  settings: "设置…", done: "任务完成",
  lock: "守护进程锁文件无效，请先检查再决定是否删除", port: "没有可供 Muster 使用的本地端口", ready: "Muster 服务器未能就绪，请查看 server.log", serverExit: "服务器已退出（{code}），请查看 server.log", otherServer: "这台机器的守护进程已连接到 {server}。请先停止它，再连接到 {origin}。",
  file: "文件", edit: "编辑", view: "视图", window: "窗口", newTask: "新建任务", browser: "在浏览器中打开", logs: "查看日志", folder: "选择工作空间仓库", open: "打开 Muster",
  connecting: "正在连接", online: "就绪", offline: "执行器未运行", running: "{count} 轮运行中", review: "待验收", failed: "任务失败",
  workerStopped: "Muster 后台进程已停止", workerError: "{name} 意外退出。日志位于 {logs}", startup: "Muster 无法启动", startupError: "{error}\n日志：{logs}", server: "服务器", daemon: "守护进程", untrusted: "不受信任的桌面请求", path: "请提供本地绝对路径",
} as const;
export function desktopText(key: keyof typeof messages, params: Record<string, string | number> = {}) {
  return messages[key].replace(/\{(\w+)\}/g, (match, name: string) => typeof params[name] === "number" ? new Intl.NumberFormat("zh-CN").format(params[name]) : params[name] ?? match);
}
export function notificationTitle(phase: string) {
  return `${desktopText(phase === "review" ? "review" : phase === "done" ? "done" : "failed")} · Muster`;
}

export function desktopError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  for (const key of ["lock", "port", "ready"] as const) if (text === errors[key]) return desktopText(key);
  const exit = text.match(/^Server exited \((.+)\); see server\.log$/);
  if (exit) return desktopText("serverExit", { code: exit[1]! });
  const connected = text.match(/^This machine's daemon is already connected to (.+)\. Stop it before connecting to (.+)\.$/);
  return connected ? desktopText("otherServer", { server: connected[1]!, origin: connected[2]! }) : text;
}
