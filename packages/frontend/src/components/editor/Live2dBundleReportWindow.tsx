/**
 * Live2dBundleReportWindow — what a Live2D bundle's manifest asked for, what
 * didn't arrive, and (when the bundle was refused) a way to supply it.
 *
 * A `*.model3.json` references its `.moc3`, textures, physics, motions and
 * expressions by path relative to itself. Before this window existed, a bundle
 * whose references didn't resolve uploaded "successfully" and then rendered as a
 * blank placeholder with nothing saying why. Three outcomes land here:
 *
 *   - **blocked** — `Moc`/`Textures` are missing, so there is nothing to render.
 *     Nothing was stored. The browser still holds the files the user picked, so
 *     this window collects the stragglers and re-uploads the complete bundle —
 *     they never re-pick what they already chose.
 *   - **warning** — only enhancements are missing. The model IS stored and does
 *     render; it just won't have those motions/expressions/physics. Read-only.
 *   - **malformed** — the manifest itself is broken (unparseable, no
 *     `FileReferences`, a path escaping the bundle). Supplying files cannot fix
 *     it, so no collection UI is offered.
 *
 * Supplied files are matched by **basename**: a user dropping `texture_00.png`
 * plainly means the `foo.2048/texture_00.png` slot, and making them rebuild the
 * directory structure by hand would defeat the point of the window. Where one
 * basename could satisfy several slots it asks rather than guesses — picking
 * wrong yields a model that loads *looking* wrong, which is worse than one that
 * does not load at all.
 *
 * The same matching runs over the upload itself (`planRelocations`), for the
 * case where every file IS present and only the folder structure was lost. Those
 * matches arrive pre-filled — but pre-filled is not the same as silent: each row
 * says where the file was found, each can be removed, and nothing is uploaded
 * until the user presses the button. That is the line this window draws between
 * "helpful" and "guessing on the user's behalf".
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BundleFileInput,
  Live2dBundleReport,
  Live2dFileRef,
} from '../../api/client';
import { HelpButton } from '../../help/HelpButton';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import type { Relocation, AmbiguousRelocation } from '../../lib/live2dBundle';

interface Props {
  report: Live2dBundleReport;
  /** Bundle folder/archive name the user picked, for the subtitle. */
  rootName: string;
  /**
   * The files already picked, held client-side so a retry doesn't re-pick them.
   * `null` for the warning case — that bundle is already stored, nothing to fix.
   */
  pending: BundleFileInput[] | null;
  /** Re-upload the completed bundle. Only called once every required slot is filled. */
  onRetry?: (files: BundleFileInput[]) => void;
  /** Missing references matched to files already in the upload, pre-filled. */
  relocations?: Relocation[];
  /** Missing references several files in the upload could fill — user decides. */
  ambiguousRelocations?: AmbiguousRelocation[];
  busy?: boolean;
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

const basename = (p: string) => p.split('/').pop() ?? p;

/** A file the user offered that no single slot claims. */
interface Leftover {
  id: string;
  file: File;
  /** Slots whose basename matches — empty means it isn't part of this bundle. */
  candidates: string[];
}

/** What is filling a slot, and where it came from. */
interface Filled {
  file: File;
  /**
   * Set when the file was already in the upload at the wrong path, and will be
   * MOVED into place rather than added. The original entry is dropped on retry
   * so the same bytes aren't uploaded twice.
   */
  movedFrom?: string;
  /** The move only matched after ignoring letter case — worth showing. */
  caseOnly?: boolean;
}

export function Live2dBundleReportWindow({
  report,
  rootName,
  pending,
  onRetry,
  relocations = [],
  ambiguousRelocations = [],
  busy = false,
  onClose,
}: Props) {
  const { t } = useTranslation('assets');
  useEscapeKey(onClose);

  const malformed = report.errors.length > 0;
  const blocked = malformed || report.missingRequired.length > 0;
  // Collection only makes sense when files would actually fix it: the bundle was
  // refused, the manifest itself parses, and we still hold what the user picked.
  const canSupply = blocked && !malformed && pending !== null && !!onRetry;

  /** Files in the upload, by their current path — the source for a relocation. */
  const filesByPath = useMemo(
    () => new Map((pending ?? []).map((f) => [f.relPath, f.file])),
    [pending]
  );

  /**
   * slot relPath → what is filling it. Seeded from the relocation plan, so a
   * bundle whose files are all present but rearranged opens already resolved —
   * visibly, with each row naming where the file was found and offering to
   * remove it, and still requiring the user to press upload.
   */
  const [supplied, setSupplied] = useState<Record<string, Filled>>(() => {
    const seed: Record<string, Filled> = {};
    for (const r of relocations) {
      const file = filesByPath.get(r.foundAt);
      if (file)
        seed[r.relPath] = { file, movedFrom: r.foundAt, caseOnly: r.caseOnly };
    }
    return seed;
  });
  const [leftovers, setLeftovers] = useState<Leftover[]>([]);
  const [dragOver, setDragOver] = useState(false);

  /** Slots the upload offers several candidates for, keyed for lookup by row. */
  const ambiguousBySlot = useMemo(
    () => new Map(ambiguousRelocations.map((a) => [a.relPath, a.candidates])),
    [ambiguousRelocations]
  );

  const missing = useMemo(
    () => [...report.missingRequired, ...report.missingOptional],
    [report]
  );

  const accept = (files: File[]) => {
    const nextSupplied = { ...supplied };
    const nextLeftovers: Leftover[] = [];
    for (const file of files) {
      const candidates = missing
        .filter(
          (m) => basename(m.relPath) === file.name && !nextSupplied[m.relPath]
        )
        .map((m) => m.relPath);
      if (candidates.length === 1) nextSupplied[candidates[0]] = { file };
      else
        nextLeftovers.push({
          id: `${file.name}:${file.size}:${nextLeftovers.length}:${leftovers.length}`,
          file,
          candidates,
        });
    }
    setSupplied(nextSupplied);
    if (nextLeftovers.length)
      setLeftovers((prev) => [...prev, ...nextLeftovers]);
  };

  const assignLeftover = (id: string, slot: string) => {
    const item = leftovers.find((l) => l.id === id);
    if (!item) return;
    setSupplied((prev) => ({ ...prev, [slot]: { file: item.file } }));
    setLeftovers((prev) => prev.filter((l) => l.id !== id));
  };

  /** Resolve an ambiguous relocation: take the file already at `foundAt`. */
  const chooseRelocation = (slot: string, foundAt: string) => {
    const file = filesByPath.get(foundAt);
    if (!file) return;
    setSupplied((prev) => {
      // One file can only be in one place. If it was already promised to
      // another slot, that slot goes back to unfilled rather than both
      // claiming the same bytes.
      const next = Object.fromEntries(
        Object.entries(prev).filter(([, v]) => v.movedFrom !== foundAt)
      );
      next[slot] = { file, movedFrom: foundAt };
      return next;
    });
  };

  const clearSlot = (slot: string) =>
    setSupplied((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });

  const requiredSatisfied = report.missingRequired.every(
    (r) => supplied[r.relPath]
  );
  const suppliedCount = Object.keys(supplied).length;
  const relocatedCount = Object.values(supplied).filter(
    (v) => v.movedFrom
  ).length;

  const retry = () => {
    if (!pending || !onRetry) return;
    // A relocated file MOVES: drop it from its old path so the bundle doesn't
    // carry the same bytes twice, once where the manifest wants them and once
    // where they were wrongly sitting.
    const moved = new Set(
      Object.values(supplied)
        .map((v) => v.movedFrom)
        .filter((p): p is string => !!p)
    );
    onRetry([
      ...pending.filter((f) => !moved.has(f.relPath)),
      ...Object.entries(supplied).map(([relPath, v]) => ({
        relPath,
        file: v.file,
      })),
    ]);
  };

  const FileRow = ({ file }: { file: Live2dFileRef }) => {
    const got = supplied[file.relPath];
    const choices = canSupply ? ambiguousBySlot.get(file.relPath) : undefined;
    return (
      <li className="vs-live2d-slot" style={{ ...rowStyle, flexWrap: 'wrap' }}>
        <span style={{ minWidth: 0 }}>
          <code style={pathStyle}>{file.relPath}</code>
          {got &&
            (got.movedFrom ? (
              <span className="vs-live2d-slot-moved" style={suppliedStyle}>
                ✓ {t('live2d.supply.foundAt', { path: got.movedFrom })}
                {got.caseOnly ? ` (${t('live2d.supply.caseOnly')})` : ''}
              </span>
            ) : (
              <span style={suppliedStyle}>✓ {t('live2d.supply.supplied')}</span>
            ))}
        </span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={kindStyle}>
            {t(`live2d.kind.${KIND_KEY[file.kind]}`)}
            {file.label ? ` · ${file.label}` : ''}
          </span>
          {canSupply && got && (
            <button
              className="vs-live2d-slot-clear"
              style={linkBtnStyle}
              onClick={() => clearSlot(file.relPath)}
            >
              {t('live2d.supply.remove')}
            </button>
          )}
        </span>
        {/* Several files in the upload share this name — the user picks, since
            handing over the wrong one yields a model that loads looking wrong. */}
        {choices && !got && (
          <select
            className="vs-live2d-relocate-slot"
            style={{ ...selectStyle, maxWidth: '100%', flexBasis: '100%' }}
            defaultValue=""
            aria-label={t('live2d.supply.chooseSource', {
              path: file.relPath,
            })}
            onChange={(e) => {
              if (e.target.value)
                chooseRelocation(file.relPath, e.target.value);
            }}
          >
            <option value="">
              {t('live2d.supply.chooseSourceOption', {
                count: choices.length,
              })}
            </option>
            {choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </li>
    );
  };

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

        {canSupply && (
          <div style={sectionStyle}>
            <div style={sectionHeaderStyle}>{t('live2d.supply.title')}</div>
            {relocatedCount > 0 && (
              <p
                className="vs-live2d-relocated-note"
                style={relocatedNoteStyle}
              >
                {t('live2d.supply.relocatedNote', { count: relocatedCount })}
              </p>
            )}
            <p style={{ ...hintStyle, margin: '0 0 8px' }}>
              {t('live2d.supply.hint')}
            </p>
            <div
              className="vs-live2d-supply-drop"
              style={{
                ...dropZoneStyle,
                borderColor: dragOver ? '#2563eb' : '#333',
                background: dragOver ? 'rgba(37,99,235,0.12)' : '#111',
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOver(false);
                accept(Array.from(e.dataTransfer.files));
              }}
            >
              <span style={{ color: '#888', fontSize: 12 }}>
                {t('live2d.supply.dropHere')}
              </span>
              <label className="vs-live2d-supply-pick" style={pickBtnStyle}>
                {t('live2d.supply.addFiles')}
                <input
                  className="vs-live2d-supply-input"
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files) accept(Array.from(e.target.files));
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            {leftovers.length > 0 && (
              <ul
                className="vs-live2d-leftovers"
                style={{ ...listStyle, marginTop: 8 }}
              >
                {leftovers.map((l) => (
                  <li key={l.id} style={{ ...rowStyle, flexWrap: 'wrap' }}>
                    <code style={pathStyle}>{l.file.name}</code>
                    {l.candidates.length === 0 ? (
                      <span style={{ ...kindStyle, color: '#f5b5b5' }}>
                        {t('live2d.supply.unmatched')}
                      </span>
                    ) : (
                      <select
                        className="vs-live2d-leftover-slot"
                        style={selectStyle}
                        defaultValue=""
                        aria-label={t('live2d.supply.ambiguous', {
                          name: l.file.name,
                        })}
                        onChange={(e) => {
                          if (e.target.value)
                            assignLeftover(l.id, e.target.value);
                        }}
                      >
                        <option value="">{t('live2d.supply.choose')}</option>
                        {l.candidates.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div
          style={{
            ...sectionStyle,
            borderBottom: 'none',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button
            className="vs-live2d-report-dismiss"
            style={dismissBtnStyle}
            onClick={onClose}
          >
            {canSupply ? t('live2d.supply.cancel') : t('live2d.report.dismiss')}
          </button>
          {canSupply && (
            <button
              className="vs-live2d-retry"
              style={{
                ...primaryBtnStyle,
                opacity: requiredSatisfied && !busy ? 1 : 0.5,
                cursor: requiredSatisfied && !busy ? 'pointer' : 'not-allowed',
              }}
              disabled={!requiredSatisfied || busy}
              onClick={retry}
            >
              {busy
                ? t('live2d.supply.retrying')
                : t('live2d.supply.retry', { count: suppliedCount })}
            </button>
          )}
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
  color: '#888',
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
const relocatedNoteStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  color: '#cfe0ff',
  background: 'rgba(37,99,235,0.12)',
  border: '1px solid rgba(37,99,235,0.4)',
  borderRadius: 4,
  padding: '8px 10px',
  lineHeight: 1.5,
};
const suppliedStyle: React.CSSProperties = {
  color: '#4ade80',
  fontSize: 11,
  marginLeft: 6,
  whiteSpace: 'nowrap',
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
const dropZoneStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 12px',
  border: '1px dashed #333',
  borderRadius: 6,
};
const pickBtnStyle: React.CSSProperties = {
  background: '#2a2a2a',
  border: '1px solid #3a3a3a',
  borderRadius: 4,
  color: '#ddd',
  cursor: 'pointer',
  fontSize: 12,
  padding: '5px 12px',
  flexShrink: 0,
};
const selectStyle: React.CSSProperties = {
  background: '#1c1c1c',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#ddd',
  fontSize: 11,
  padding: '2px 6px',
  maxWidth: '60%',
};
const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#7aa2ff',
  cursor: 'pointer',
  fontSize: 11,
  padding: 0,
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
const primaryBtnStyle: React.CSSProperties = {
  background: '#2563eb',
  border: '1px solid #2563eb',
  borderRadius: 4,
  color: '#fff',
  fontSize: 12,
  padding: '6px 14px',
};
