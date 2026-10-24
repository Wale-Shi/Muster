export const locales = ["en", "zh-CN"] as const;
export type Locale = typeof locales[number];
export const isLocale = (value: unknown): value is Locale => locales.some((locale) => locale === value);
// First preferred language Muster supports wins; any Chinese variant maps to zh-CN.
export function resolveLocale(languages: readonly string[]): Locale {
  for (const language of languages.map((value) => value.toLowerCase())) {
    if (language.startsWith("zh")) return "zh-CN";
    if (language.startsWith("en")) return "en";
  }
  return "en";
}
