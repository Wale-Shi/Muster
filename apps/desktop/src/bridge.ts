export type DesktopCommand = { type: "new-task" } | { type: "open-todo"; id: string };
export interface DesktopBridge {
  desktop: true;
  platform: string;
  chooseFolder(): Promise<string | null>;
  openPath(path: string): Promise<string>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
}
