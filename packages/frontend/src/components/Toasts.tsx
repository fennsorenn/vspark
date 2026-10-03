/**
 * The toast stack — transient notices, bottom-right, above everything.
 *
 * Mounted once next to {@link ./DialogProvider} so every surface (editor,
 * viewer, home) shares one stack. Unlike the dialogs it sits beside, a toast
 * asks nothing and blocks nothing: it reports something that already happened,
 * most often a mesh write the authority refused (see
 * {@link ../mesh/writeFeedback}).
 */
import { useTranslation } from 'react-i18next';
import { useToastStore } from '../store/toastStore';

export function Toasts() {
  const { t } = useTranslation('misc');
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      // Announced politely: a refused write matters, but not enough to
      // interrupt whatever a screen reader is currently on.
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        // The stack is an overlay, not a surface: only the cards take pointer
        // events, so it never swallows a click meant for the editor beneath.
        pointerEvents: 'none',
        maxWidth: 'min(420px, calc(100vw - 32px))',
      }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 6,
            background: '#1f2430',
            border: `1px solid ${toast.kind === 'error' ? '#b91c1c' : '#374151'}`,
            borderLeft: `3px solid ${toast.kind === 'error' ? '#ef4444' : '#60a5fa'}`,
            color: '#e5e7eb',
            fontSize: 12,
            lineHeight: 1.45,
            boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
          }}
        >
          <span style={{ flex: 1, wordBreak: 'break-word' }}>
            {toast.message}
          </span>
          <button
            className="vs-toast-dismiss"
            title={t('toast.dismiss')}
            aria-label={t('toast.dismiss')}
            onClick={() => dismiss(toast.id)}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              cursor: 'pointer',
              padding: 0,
              lineHeight: 1,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
