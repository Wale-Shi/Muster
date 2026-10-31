import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTheme } from "./usePreferences";
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { delete window.muster; vi.unstubAllGlobals(); });
it("starts the desktop window dark", () => {
  window.muster = { desktop: true, platform: "darwin", chooseFolder: vi.fn(), openPath: vi.fn(), onCommand: vi.fn() };
  expect(renderHook(() => useTheme()).result.current.theme).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("follows the system appearance in a browser", () => {
  expect(renderHook(() => useTheme()).result.current.theme).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("keeps a theme the user chose in the desktop window", () => {
  localStorage.setItem("muster.theme", "light");
  window.muster = { desktop: true, platform: "darwin", chooseFolder: vi.fn(), openPath: vi.fn(), onCommand: vi.fn() };
  expect(renderHook(() => useTheme()).result.current.theme).toBe("light");
});
