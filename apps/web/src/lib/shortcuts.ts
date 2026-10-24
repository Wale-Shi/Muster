import type { MessageKey } from "../i18n";
export type ShortcutCommand = "searchAll" | "searchTasks" | "searchTopics" | "newTask" | "back" | "sidebar" | "panel" | "maximize" | "complete" | "settings" | "shortcuts" | "close";
export interface Shortcut { command: ShortcutCommand; code: string; keys: string; label: MessageKey; mod?: boolean; alt?: boolean; shift?: boolean; outsideInput?: boolean }
export const shortcuts: readonly Shortcut[] = [
  { command: "searchAll", code: "KeyK", keys: "⌘K", mod: true, label: "phaseC.searchAll" },
  { command: "searchTasks", code: "KeyP", keys: "⌘P", mod: true, label: "phaseC.searchTasks" },
  { command: "searchTopics", code: "KeyJ", keys: "⌘J", mod: true, label: "phaseC.searchTopics" },
  { command: "newTask", code: "KeyN", keys: "⌘N", mod: true, label: "phaseC.newTask" },
  { command: "newTask", code: "KeyN", keys: "N", outsideInput: true, label: "phaseC.newTaskPlain" },
  { command: "back", code: "BracketLeft", keys: "⌘[", mod: true, label: "phaseC.back" },
  { command: "sidebar", code: "KeyB", keys: "⌘B", mod: true, label: "phaseC.sidebar" },
  { command: "panel", code: "KeyB", keys: "⌘⌥B", mod: true, alt: true, label: "phaseC.panel" },
  { command: "maximize", code: "Enter", keys: "⌘⇧Enter", mod: true, shift: true, label: "phaseC.maximize" },
  { command: "complete", code: "Enter", keys: "⌘⌥Enter", mod: true, alt: true, outsideInput: true, label: "phaseC.complete" },
  { command: "settings", code: "Comma", keys: "⌘,", mod: true, label: "phaseC.settings" },
  { command: "shortcuts", code: "Slash", keys: "⌘/", mod: true, label: "phaseC.shortcuts" },
  { command: "close", code: "Escape", keys: "Esc", label: "phaseC.close" },
];
export function matchShortcut(event: KeyboardEvent) {
  const typing = event.target instanceof HTMLElement && !!event.target.closest('input, textarea, select, [contenteditable="true"]');
  return shortcuts.find((s) => s.code === event.code && !!s.mod === (event.metaKey || event.ctrlKey) && !!s.alt === event.altKey && !!s.shift === event.shiftKey && !(s.outsideInput && typing));
}
export function dispatchShortcut(command: ShortcutCommand) { window.dispatchEvent(new CustomEvent("muster:shortcut", { detail: command })); }
