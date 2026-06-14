import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n';

/** Compact language selector. Persists the choice via i18next's localStorage detector. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { i18n } = useTranslation();
  // i18next may report a region tag (e.g. `en-US`); match on the base code.
  const current = i18n.language?.split('-')[0] ?? 'en';

  return (
    <select
      value={current}
      onChange={(e) => void i18n.changeLanguage(e.target.value)}
      title="Language / Sprache"
      style={{
        background: '#222',
        border: '1px solid #333',
        borderRadius: 5,
        color: '#ccc',
        padding: compact ? '2px 6px' : '3px 8px',
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {compact ? l.code.toUpperCase() : l.label}
        </option>
      ))}
    </select>
  );
}
