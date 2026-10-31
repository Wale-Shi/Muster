import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, DesktopCommand } from "./bridge.js";
const bridge: DesktopBridge = {
  desktop: true,
  platform: process.platform,
  chooseFolder: () => ipcRenderer.invoke("muster:choose-folder") as Promise<string | null>,
  openPath: (path) => ipcRenderer.invoke("muster:open-path", path) as Promise<string>,
  onCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: DesktopCommand) => callback(command);
    let active = true;
    let receivedFullscreen = false;
    const dispatch = (event: Electron.IpcRendererEvent, command: DesktopCommand) => {
      if (command.type === "fullscreen") receivedFullscreen = true;
      listener(event, command);
    };
    ipcRenderer.on("muster:command", dispatch);
    // A renderer reload also needs the current native window state.
    void ipcRenderer.invoke("muster:get-fullscreen").then((fullscreen: boolean) => {
      if (active && !receivedFullscreen) callback({ type: "fullscreen", fullscreen });
    }).catch(() => { /* Window may be closing. */ });
    return () => { active = false; ipcRenderer.removeListener("muster:command", dispatch); };
  },
};
contextBridge.exposeInMainWorld("muster", bridge);
