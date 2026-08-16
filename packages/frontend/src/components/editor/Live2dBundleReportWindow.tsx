/**
 * Live2dBundleReportWindow — what a Live2D bundle's manifest asked for and the
 * upload didn't contain.
 *
 * A `*.model3.json` references its `.moc3`, textures, physics, motions and
 * expressions by path relative to itself. Before this window existed, a bundle
 * whose references didn't resolve uploaded "successfully" and then rendered as a
 * blank placeholder with nothing saying why. The backend now checks the manifest
 * against the arriving file set and this window shows the result:
 *
 *   - **blocked** — `Moc`/`Textures` are missing, so there is nothing to render.
 *     Nothing was stored; the user must re-upload with the files included.
 *   - **warning** — only enhancements are missing. The model IS stored and does
 *     render; it just won't have those motions/expressions/physics.
 *   - **malformed** — the manifest itself is broken (unparseable, no
 *     `FileReferences`, a path escaping the bundle). Supplying files can't fix it.
 *
 * Read-only for now: it reports, it doesn't collect. The incremental completion
 * flow (drop the missing files straight into these rows) builds on this shell.
 */
import { useTranslation } from 'react-i18next';
import type { Live2dBundleReport, Live2dFileRef } from '../../api/client';
import { HelpButton } from '../../help/HelpButton';
import { useEscapeKey } from '../../hooks/useEscapeKey';

interface Props {
  report: Live2dBundleReport;
  /** Bundle folder/archive name the user picked, for the subtitle. */
  rootName: string;
  onClose: () => void;
}

/** i18n key suffix per reference kind — what the file is, in the user's words. */
const KIND_KEY: Record<Live2dFileRef['kind'], string> = {
  moc: 'moc',
  texture: 'texture',
  physics: 'physics',
  pose: 'pose',
  displayInfo: 'displayInfo',
  expression: 'expression',
  motion: 'motion',
  motionSound: 'motionSound',
  userData: 'userData',
};

export function Live2dBundleReportWindow({ report, rootName, onClose }: Props) {
  const { t } = useTranslation('assets');
  useEscapeKey(onClose);

  const malformed = report.errors.length > 0;
  const blocked = malformed || report.missingRequired.length > 0;

  const FileRow = ({ file }: { file: Live2dFileRef }) => (
    <li style={rowStyle}>
      <code style={pathStyle}>{file.relPath}</code>
      <span style={kindStyle}>
        {t(`live2d.kind.${KIND_KEY[file.kind]}`)}
        {file.label ? ` · ${file.label}` : ''}
      </span>
    </li>
  );

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="vs-live2d-report"
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-label={t('live2d.report.title')}
      >
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>
              {blocked
                ? t('live2d.report.title')
                : t('live2d.report.titleIncomplete')}
            </span>
            <HelpButton
              topic="live2d"
              anchor="missing-files"
              tip={t('help.live2dMissing')}
            />
          </div>
          <button
            className="vs-live2d-report-close"
            style={closeBtnStyle}
            onClick={onClose}
            aria-label={t('live2d.report.close')}
          >
            ×
          </button>
        </div>

        <div style={sectionStyle}>
          <p style={leadStyle}>
            {blocked
              ? t('live2d.report.leadBlocked', { name: rootName })
              : t('live2d.report.leadWarning', { name: rootName })}
          </p>
          <p style={manifestStyle}>
            {t('live2d.report.manifest')} <code>{report.manifest}</code>
          </p>
        </div>

        {malformed && (
          <div style={sectionStyle}>
            <div style={{ ...sectionHeaderStyle, color: '#f87171' }}>
              {t('live2d.report.malformed')}
            </div>
            <ul className="vs-live2d-report-errors" style={listStyle}>
              {report.errors.map((e) => (
                <li key={e} style={{ ...rowStyle, color: '#f5b5b5' }}>
                  {e}
                </li>
              ))}
            </ul>
            <p style={hintStyle}>{t('live2d.report.malformedHint')}</p>
          </div>
        )}

        {report.missingRequired.length > 0 && (
          <div style={sectionStyle}>
            <div style={{ ...sectionHeaderStyle, color: '#f87171' }}>
              {t('live2d.report.required', {
                count: report.missingRequired.length,
              })}
            </div>
            <ul className="vs-live2d-report-required" style={listStyle}>
              {report.missingRequired.map((f) => (
                <FileRow key={f.relPath} file={f} />
              ))}
            </ul>
            <p style={hintStyle}>{t('live2d.report.requiredHint')}</p>
          </div>
        )}

        {report.missingOptional.length > 0 && (
          <div style={sectionStyle}>
            <div style={{ ...sectionHeaderStyle, color: '#facc15' }}>
              {t('live2d.report.optional', {
                count: report.missingOptional.length,
              })}
            </div>
            <ul className="vs-live2d-report-optional" style={listStyle}>
              {report.missingOptional.map((f) => (
                <FileRow key={f.relPath} file={f} />
              ))}
            </ul>
            <p style={hintStyle}>{t('live2d.report.optionalHint')}</p>
          </div>
        )}

        <div
          style={{ ...sectionStyle, borderBottom: 'none', textAlign: 'right' }}
        >
          <button
            className="vs-live2d-report-dismiss"
            style={dismissBtnStyle}
            onClick={onClose}
          >
            {t('live2d.report.dismiss')}
          </button>
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
  maxWidth: 560,
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
const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};
const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 12,
  padding: '4px 8px',
  background: '#111',
  border: '1px solid #262626',
  borderRadius: 4,
};
const pathStyle: React.CSSProperties = {
  color: '#ddd',
  fontFamily: 'ui-monospace, monospace',
  wordBreak: 'break-all',
};
const kindStyle: React.CSSProperties = {
  color: '#888',
  fontSize: 11,
  whiteSpace: 'nowrap',
  flexShrink: 0,
};
const leadStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: '#ccc',
  lineHeight: 1.5,
};
const manifestStyle: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 11,
  color: '#777',
};
const hintStyle: React.CSSProperties = {
  margin: '8px 0 0',
  fontSize: 11,
  color: '#888',
  lineHeight: 1.5,
};
const dismissBtnStyle: React.CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  color: '#ddd',
  cursor: 'pointer',
  fontSize: 12,
  padding: '6px 14px',
};
