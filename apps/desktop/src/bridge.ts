import type { Locale } from "@muster/shared";
export type DesktopCommand = { type: "fullscreen"; fullscreen: boolean } | { type: "new-task" } | { type: "settings" } | { type: "shortcuts" } | { type: "open-todo"; id: string };
export interface DesktopBridge {
  setLocale(locale: Locale): Promise<void>;
  desktop: true;
  platform: string;
  chooseFolder(): Promise<string | null>;
  openPath(path: string): Promise<string>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
}
