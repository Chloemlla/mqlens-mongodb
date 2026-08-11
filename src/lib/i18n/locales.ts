/** Every locale that ships. Adding one means adding a folder under src/locales
 *  and an entry here — nothing else. */
export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number]['code'];

export const DEFAULT_LOCALE: Locale = 'en';

/** Guard for a persisted value, which may be stale or hand-edited. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((l) => l.code === value);
}

/**
 * What the user picked, which is not the same thing as the locale we run in:
 * `system` means "follow the device". Mirrors ThemeMode's `system` option — the
 * split matters because "chose English" and "never chose" must stay
 * distinguishable, or a German device would be overridden forever by a default.
 */
export const SYSTEM_LOCALE: 'system' = 'system';
export type LocaleSetting = typeof SYSTEM_LOCALE | Locale;

/** The default is `system`, so a German user gets German without hunting for a setting. */
export const DEFAULT_LOCALE_SETTING: LocaleSetting = SYSTEM_LOCALE;

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === SYSTEM_LOCALE || isSupportedLocale(value);
}

/**
 * Resolve the setting to the locale to actually run in.
 *
 * An explicit choice always wins. For `system` (and for anything unrecognised,
 * so a stale config degrades to auto rather than to nothing) we walk the
 * device's languages in preference order and match on the PRIMARY SUBTAG, so
 * `de-AT` and `de-CH` are German speakers rather than English fallbacks.
 * Falls back to English when nothing preferred is shipped.
 *
 * Pure — takes the language list rather than reading `navigator`, so it is
 * testable and callable from anywhere.
 */
export function resolveLocale(
  setting: LocaleSetting,
  languages: readonly string[] | undefined
): Locale {
  if (isSupportedLocale(setting)) return setting;
  for (const tag of languages ?? []) {
    for (const candidate of matchesFor(tag)) {
      const hit = SUPPORTED_LOCALES.find((l) => l.code.toLowerCase() === candidate);
      if (hit) return hit.code;
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * What a device language tag could match, most specific first.
 *
 * The primary subtag alone is not enough once a language ships in more than one
 * script: `zh-Hans` and `zh-Hant` are different catalogs and both start `zh`,
 * so matching on `zh` would hand a reader of one the other.
 *
 * Parsed with `Intl.Locale` rather than by splitting on dashes. A tag can carry
 * extensions — `zh-TW-u-nu-latn` asks for Traditional Chinese with Latin
 * numerals — and picking subtags out by length reads that `latn` as the script,
 * sending a valid Chinese preference somewhere that does not exist. `Intl` also
 * knows which script a language and region imply, so `zh-TW` reaches
 * traditional and a bare `zh` reaches simplified out of CLDR's own data instead
 * of a table maintained here.
 *
 * A candidate that matches no shipped catalog simply falls through, which is
 * why a single-script language contributes a harmless `de-latn` before `de`.
 *
 * Exported for its tests: the mapping is the whole substance of picking a
 * locale, and it cannot be exercised through {@link resolveLocale} until the
 * catalogs it points at exist.
 */
export function matchesFor(tag: string): string[] {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(String(tag));
  } catch {
    // Not a well-formed tag. The leading subtag is the most that can be
    // salvaged, and an empty tag yields nothing at all.
    const language = String(tag).split('-')[0]?.toLowerCase();
    return language ? [language] : [];
  }
  // `und` — "undetermined" — is a well-formed tag whose language is absent, so
  // this cannot assume there is one to lower-case. Reading it off the
  // maximized locale answers it where CLDR can (`und-TW` is Chinese) and
  // leaves nothing to match where it cannot, rather than throwing out of a
  // function that runs while the app is deciding what language to start in.
  const maximized = maximize(locale);
  // Only where the tag says something else. A bare `und` maximizes to English,
  // and letting it match would answer "I don't know" with a language and
  // swallow the preference listed after it; `und-TW` genuinely does point
  // somewhere, so its region is allowed to speak.
  const impliedLanguage = locale.region || locale.script ? maximized?.language : undefined;
  const language = (locale.language ?? impliedLanguage)?.toLowerCase();
  if (!language) return [];
  const script = locale.script ?? maximized?.script;
  const candidates: string[] = [];
  if (script) candidates.push(`${language}-${script.toLowerCase()}`);
  candidates.push(language);
  return candidates;
}

/** The tag with the script and language CLDR considers likely, or null where
 *  the runtime ships no likely-subtags data. */
function maximize(locale: Intl.Locale): Intl.Locale | null {
  try {
    return locale.maximize();
  } catch {
    return null;
  }
}

/** The device's preferred languages, most-preferred first. */
export function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
