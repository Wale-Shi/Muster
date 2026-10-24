import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopCommand } from "./bridge.js";
const bridge: DesktopBridge = {
  setLocale: (locale) => ipcRenderer.invoke("muster:set-locale", locale) as Promise<void>,
  desktop: true,
  platform: process.platform,
  chooseFolder: () => ipcRenderer.invoke("muster:choose-folder") as Promise<string | null>,
  openPath: (path) => ipcRenderer.invoke("muster:open-path", path) as Promise<string>,
  onCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: DesktopCommand) => callback(command);
    ipcRenderer.on("muster:command", listener);
    return () => ipcRenderer.removeListener("muster:command", listener);
  },
};
contextBridge.exposeInMainWorld("muster", bridge);
