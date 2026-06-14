import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

/**
 * i18n bootstrap.
 *
 * Translation resources live under `./locales/<lng>/<namespace>.json` and are
 * imported eagerly via Vite's `import.meta.glob`. This means a new namespace
 * file is picked up automatically — no central registration list to keep in
 * sync as more of the app gets translated.
 */
const modules = import.meta.glob('./locales/*/*.json', { eager: true });

// i18next's `Resource` type wants each namespace to be a `ResourceKey`; the
// JSON modules are statically typed as `unknown`, so collect into a loosely
// typed map and let i18next validate the shape at runtime.
const resources: Record<string, Record<string, Record<string, unknown>>> = {};

for (const [path, mod] of Object.entries(modules)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, lng, ns] = match;
  (resources[lng] ??= {})[ns] = (mod as { default: Record<string, unknown> })
    .default;
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const LANGUAGE_STORAGE_KEY = 'vspark.lang';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    defaultNS: 'common',
    // Missing keys fall back to the key itself (and to `en`), so an
    // un-migrated string never renders blank during the incremental rollout.
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
  });

export default i18n;
