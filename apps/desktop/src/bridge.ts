export type DesktopCommand = { type: "fullscreen"; fullscreen: boolean } | { type: "new-task" } | { type: "settings" } | { type: "open-todo"; id: string };
export interface DesktopBridge {
  desktop: true;
  platform: string;
  chooseFolder(): Promise<string | null>;
  openPath(path: string): Promise<string>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
}
