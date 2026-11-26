/**
 * The small "composite" tag shown on a composite in the create palette and on
 * its root row in the scene / compose tree. Composites sit with the base 3D
 * objects and 2D layers; this tag is what tells them apart (decided, user
 * 2026-11-08).
 */
import { useTranslation } from 'react-i18next';

export function CompositeTag() {
  const { t } = useTranslation('composites');
  return (
    <span
      title={t('tagTip')}
      style={{
        fontSize: 9,
        lineHeight: 1,
        padding: '2px 4px',
        borderRadius: 3,
        border: '1px solid #3d5a80',
        color: '#8fb3e0',
        background: '#1a2636',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        flexShrink: 0,
        marginLeft: 'auto',
      }}
    >
      {t('tag')}
    </span>
  );
}
