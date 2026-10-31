import type { MenuItemConstructorOptions } from "electron";

// macOS only auto-adds its fullscreen item to a menu titled "View", so a localized View menu keeps Electron's
// item and main.ts turns the system one off (NSFullScreenMenuItemEverywhere) to avoid a duplicate.
export function viewMenuRoles(packaged: boolean): NonNullable<MenuItemConstructorOptions["role"]>[] {
  return [
    "reload", "forceReload",
    ...(!packaged ? ["toggleDevTools"] as const : []),
    "resetZoom", "zoomIn", "zoomOut", "togglefullscreen",
  ];
}

export const commandAccelerators = { settings: "CmdOrCtrl+," } as const;
