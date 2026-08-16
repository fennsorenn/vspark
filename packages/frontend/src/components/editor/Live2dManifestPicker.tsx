/**
 * Live2dManifestPicker — which model, when a folder or archive holds several.
 *
 * One bundle directory registers exactly one `*.model3.json` as its asset, so an
 * archive with two models is genuinely ambiguous. Taking the first silently
 * would store the others as dead weight under a model the user never chose, so
 * the choice is theirs to make.
 */
import { useTranslation } from 'react-i18next';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface Props {
  /** Bundle-relative paths of every manifest found, in discovery order. */
  manifests: string[];
  /** Folder or archive name, for the subtitle. */
  rootName: string;
  onPick: (manifestRelPath: string) => void;
  onClose: () => void;
}

export function Live2dManifestPicker({
  manifests,
  rootName,
  onPick,
  onClose,
}: Props) {
  const { t } = useTranslation('assets');
  useEscapeKey(onClose);

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="vs-live2d-picker"
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t('live2d.picker.title')}
      >
        <div style={headerStyle}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>
            {t('live2d.picker.title')}
          </span>
          <button
            className="vs-live2d-picker-close"
            style={closeBtnStyle}
            onClick={onClose}
            aria-label={t('live2d.report.close')}
          >
            ×
          </button>
        </div>

        <div style={sectionStyle}>
          <p style={leadStyle}>
            {t('live2d.picker.lead', {
              name: rootName,
              count: manifests.length,
            })}
          </p>
        </div>

        <div style={{ ...sectionStyle, borderBottom: 'none' }}>
          <ul style={listStyle}>
            {manifests.map((m) => (
              <li key={m}>
                <button
                  className="vs-live2d-picker-option"
                  style={optionStyle}
                  onClick={() => onPick(m)}
                >
                  <code style={pathStyle}>{m}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  zIndex: 1000,
  paddingTop: 60,
};
const modalStyle: React.CSSProperties = {
  background: '#181818',
  border: '1px solid #2a2a2a',
  borderRadius: 8,
  width: '90%',
  maxWidth: 480,
  maxHeight: '80vh',
  overflow: 'auto',
  fontFamily: 'system-ui, sans-serif',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#777',
  cursor: 'pointer',
  fontSize: 20,
  padding: 0,
  lineHeight: 1,
};
const sectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid #2a2a2a',
};
const leadStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: '#ccc',
  lineHeight: 1.5,
};
const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const optionStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: '#111',
  border: '1px solid #333',
  borderRadius: 4,
  cursor: 'pointer',
  padding: '8px 10px',
};
const pathStyle: React.CSSProperties = {
  color: '#ddd',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
};
