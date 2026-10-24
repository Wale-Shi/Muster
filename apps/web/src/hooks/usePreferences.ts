import { useCallback, useEffect, useState } from "react";

export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`muster.${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback(
    (next: T | ((prior: T) => T)) =>
      setValue((prior) => {
        const result =
          typeof next === "function" ? (next as (prior: T) => T)(prior) : next;
        try {
          localStorage.setItem(`muster.${key}`, JSON.stringify(result));
        } catch {
          /* Storage may be disabled. */
        }
        return result;
      }),
    [key],
  );
  return [value, update] as const;
}
export function useTheme() {
  const [theme, setTheme] = useState<"system" | "dark" | "light">(() => {
    // The desktop window starts dark; browsers follow the system appearance.
    const fallback = window.muster?.desktop ? "dark" : "system";
    try {
      const saved = localStorage.getItem("muster.theme");
      return saved === "system" || saved === "dark" || saved === "light" ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("muster.theme", theme);
    } catch {
      /* Storage may be disabled. */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return {
    theme,
    cycle: () =>
      setTheme((current) =>
        current === "system" ? "dark" : current === "dark" ? "light" : "system",
      ),
  };
}
