import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 25's Web Storage globals can shadow Vitest's jsdom window storage.
// Install isolated in-memory stores without reading experimental getters.
function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}
for (const name of ["localStorage", "sessionStorage"] as const) {
  const value = createStorage();
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(window, name, { configurable: true, value });
}
afterEach(cleanup);
