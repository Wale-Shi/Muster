// A host that embeds the web UI may expose this bridge; browsers (and the native macOS app, which does not embed the
// web UI) leave `window.muster` undefined, so every use is optional.
export type DesktopCommand = { type: "fullscreen"; fullscreen: boolean } | { type: "new-task" } | { type: "settings" } | { type: "open-todo"; id: string };
export interface DesktopBridge {
  desktop: true;
  platform: string;
  chooseFolder(): Promise<string | null>;
  openPath(path: string): Promise<string>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
}
declare global { interface Window { muster?: DesktopBridge } }
