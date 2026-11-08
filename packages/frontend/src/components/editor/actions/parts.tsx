/**
 * Pieces shared by the Actions list (left dock) and the action editor (main
 * view): the settings preview, status badges, the name field and a render
 * boundary.
 */
import { Component, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActionPreview, PreviewToken } from '@vspark/shared/actions';
import { useSceneNodes } from '../../../mesh/nodes';
import { useComposeLayers } from '../../../mesh/compose';
import { useTrackClips } from '../../../mesh/hooks';
import {
  commitActionPatch,
  statusOf,
  type ActionRecord,
} from '../../../mesh/actions';
import { inputStyle } from './styles';

// ── preview ──────────────────────────────────────────────────────────────────

/** Resolve an entity reference to its display name (falls back to the id). */
function useRefName(): (ref: string, id: string) => string {
  const nodes = useSceneNodes();
  const layers = useComposeLayers();
  const clips = useTrackClips();
  return (ref, id) => {
    if (ref === 'clip') return clips.find((c) => c.id === id)?.name || id;
    const node = nodes.find((n) => n.id === id);
    if (node && ref !== 'composeLayer') return node.name || id;
    const layer = layers.find((l) => l.id === id);
    if (layer && ref !== 'sceneNode') return layer.name || id;
    return id;
  };
}

/** A preview token as display text. */
function useTokenText(): (tok: PreviewToken) => string {
  const { t } = useTranslation('actions');
  const refName = useRefName();
  return (tok) =>
    tok.t === 'text'
      ? tok.text
      : tok.t === 'msg'
        ? t(tok.key, tok.params ?? {})
        : refName(tok.ref, tok.id);
}

/** The most important settings of an action, as its kind declares them, on
 *  one line: the headline, then each line after an arrow. Cut off with an
 *  ellipsis when it doesn't fit; the full text is the tooltip. */
export function PreviewLine({ preview }: { preview: ActionPreview }) {
  const text = useTokenText();
  const head = preview.headline.map(text).join(' ');
  const lines = preview.lines.map((line) => line.map(text).join(' '));
  return (
    <span
      className="vs-action-preview"
      title={[head, ...lines].join(' → ')}
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 11,
        color: '#888',
      }}
    >
      <span style={{ fontFamily: 'monospace', color: '#ccc' }}>{head}</span>
      {lines.map((line, i) => (
        <span key={i}> → {line}</span>
      ))}
    </span>
  );
}

// ── badges ───────────────────────────────────────────────────────────────────

function Badge({
  className,
  label,
  tip,
  color,
  compact,
}: {
  className: string;
  label: string;
  tip: string;
  color: string;
  compact?: boolean;
}) {
  if (compact)
    return (
      <span
        className={className}
        title={`${label}: ${tip}`}
        aria-label={label}
        role="img"
        style={{
          flexShrink: 0,
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
        }}
      />
    );
  return (
    <span
      className={className}
      title={tip}
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 8,
        border: `1px solid ${color}`,
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

/** Modified / template update / no graph — the action's graph against what its
 *  settings would generate. `compact` shows each as a coloured dot (list rows). */
export function StatusBadges({
  status,
  compact,
}: {
  status: ReturnType<typeof statusOf>;
  compact?: boolean;
}) {
  const { t } = useTranslation('actions');
  return (
    <>
      {status.modified && (
        <Badge
          compact={compact}
          className="vs-action-badge-modified"
          label={t('badge.modified')}
          tip={t('badge.modifiedTip')}
          color="#d9a441"
        />
      )}
      {status.templateUpdateAvailable && !status.missingGraph && (
        <Badge
          compact={compact}
          className="vs-action-badge-template"
          label={t('badge.templateUpdate')}
          tip={t('badge.templateUpdateTip')}
          color="#5aa0d9"
        />
      )}
      {status.missingGraph && (
        <Badge
          compact={compact}
          className="vs-action-badge-missing"
          label={t('badge.missingGraph')}
          tip={t('badge.missingGraphTip')}
          color="#c66"
        />
      )}
    </>
  );
}

// ── form pieces ──────────────────────────────────────────────────────────────

export function NameField({ action }: { action: ActionRecord }) {
  const { t } = useTranslation('actions');
  const [draft, setDraft] = useState(action.name);
  useEffect(() => setDraft(action.name), [action.name]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== action.name) commitActionPatch(action.id, { name });
    else setDraft(action.name);
  };
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        color: '#888',
      }}
    >
      <span style={{ minWidth: 52 }}>{t('form.name')}</span>
      <input
        className="vs-action-name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        style={{ ...inputStyle, flex: 1 }}
      />
    </label>
  );
}

// ── boundary ─────────────────────────────────────────────────────────────────

/** A render throw in one action's UI must never white-screen the editor. */
export class RenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[actions] render failed', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
