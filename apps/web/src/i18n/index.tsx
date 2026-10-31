import { createContext, useContext, useEffect, type ReactNode } from "react";
import { messages } from "./zh-CN";
export type { Messages } from "./zh-CN";
type Keys<T> = { [K in keyof T & string]: T[K] extends string | { one: string; other: string } ? K : `${K}.${Keys<T[K]>}` }[keyof T & string];
export type MessageKey = Keys<typeof messages>;
type Params = Record<string, string | number>;
const locale = "zh-CN" as const;
export function createI18n() {
  const formatNumber = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value);
  const t = (key: MessageKey, params: Params = {}): string => {
    let value: unknown = messages;
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
  // Compact elapsed time for dense cards ("57分钟"); full date goes in the tooltip.
  const formatAge = (date: string | number | Date, now = Date.now()) => {
    const seconds = Math.max(0, (now - new Date(date).getTime()) / 1000);
    const [unit, scale] = seconds < 60 ? ["second", 1] : seconds < 3600 ? ["minute", 60] : seconds < 86400 ? ["hour", 3600] : ["day", 86400];
    return formatNumber(Math.floor(seconds / scale), { style: "unit", unit, unitDisplay: "narrow" });
  };
  const label = (group: "phase" | "runtime" | "status", code: string) => Object.hasOwn(messages[group], code) ? t(`${group}.${code}` as MessageKey) : code;
  return { locale, t, formatDate, formatRelative, formatAge, formatNumber, formatDuration, label };
}
const value = createI18n();
const Context = createContext(value);
export function I18nProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = value.t("text.title");
  }, []);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useI18n = () => useContext(Context);
