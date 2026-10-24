import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isLocale, locales, resolveLocale, type Locale } from "@muster/shared";
import { en, type Messages } from "./en";
const modules = import.meta.glob<{ messages: Messages }>(["./*.ts", "!./*.test.ts", "!./errors.ts", "!./system.ts"], { eager: true });
export const dictionaries = Object.fromEntries(locales.map((locale) => [locale, modules[`./${locale}.ts`]!.messages])) as Record<Locale, Messages>;
export const languageNames = Object.fromEntries(locales.map((locale) => [locale, dictionaries[locale].languageName])) as Record<Locale, string>;
type Keys<T> = { [K in keyof T & string]: T[K] extends string | { one: string; other: string } ? K : `${K}.${Keys<T[K]>}` }[keyof T & string];
export type MessageKey = Keys<typeof en>;
type Params = Record<string, string | number>;
export function createI18n(locale: Locale) {
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value);
  const t = (key: MessageKey, params: Params = {}): string => {
    let value: unknown = dictionaries[locale];
    for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
    if (typeof value !== "string") {
      const forms = value as Record<string, string>;
      value = forms[new Intl.PluralRules(locale).select(Number(params.count ?? 0))] ?? forms.other;
    }
    return (value as string).replace(/\{(\w+)\}/g, (match, name: string) => params[name] === undefined ? match : typeof params[name] === "number" ? formatNumber(params[name]) : String(params[name]));
  };
  const formatDate = (date: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) => new Intl.DateTimeFormat(locale, options).format(new Date(date));
  const formatRelative = (date: string | number | Date, now = Date.now()) => {
    const seconds = (new Date(date).getTime() - now) / 1000;
    const [unit, scale]: [Intl.RelativeTimeFormatUnit, number] = Math.abs(seconds) < 60 ? ["second", 1] : Math.abs(seconds) < 3600 ? ["minute", 60] : Math.abs(seconds) < 86400 ? ["hour", 3600] : ["day", 86400];
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(Math.round(seconds / scale), unit);
  };
  const formatDuration = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const unit = (value: number, name: string) => formatNumber(value, { style: "unit", unit: name, unitDisplay: "narrow" });
    return seconds < 60 ? unit(seconds, "second") : seconds < 3600 ? unit(Math.floor(seconds / 60), "minute") : `${unit(Math.floor(seconds / 3600), "hour")} ${unit(Math.floor(seconds % 3600 / 60), "minute")}`;
  };
  // Compact elapsed time for dense cards ("57m", "57分钟"); full date goes in the tooltip.
  const formatAge = (date: string | number | Date, now = Date.now()) => {
    const seconds = Math.max(0, (now - new Date(date).getTime()) / 1000);
    const [unit, scale] = seconds < 60 ? ["second", 1] : seconds < 3600 ? ["minute", 60] : seconds < 86400 ? ["hour", 3600] : ["day", 86400];
    return formatNumber(Math.floor(seconds / scale), { style: "unit", unit, unitDisplay: "narrow" });
  };
  const label = (group: "phase" | "runtime" | "status", code: string) => Object.hasOwn(en[group], code) ? t(`${group}.${code}` as MessageKey) : code;
  return { locale, t, formatDate, formatRelative, formatAge, formatNumber, formatDuration, label };
}
function initialLocale(): Locale {
  try { const saved = localStorage.getItem("muster.locale"); if (isLocale(saved)) return saved; } catch { /* storage unavailable */ }
  return resolveLocale(navigator.languages);
}
const Context = createContext({ ...createI18n("en"), setLocale: (_locale: Locale) => {} });
export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initial ?? initialLocale);
  const value = useMemo(() => ({ ...createI18n(locale), setLocale }), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = value.t("text.title");
    try { localStorage.setItem("muster.locale", locale); } catch { /* storage unavailable */ }
    void window.muster?.setLocale?.(locale).catch(console.error);
  }, [locale, value]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useI18n = () => useContext(Context);
