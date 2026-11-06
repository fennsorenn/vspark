/**
 * Actions panel (left-dock tab) — project-level workflows configured by a
 * settings form, each backed by a stored, editable Logic graph generated from
 * its kind's template. See dev-notes/modules/actions.md.
 *
 * Grouped by kind; each row previews its most important settings (the kind
 * declares the preview in @vspark/shared/actions), shows Modified / template
 * update badges, and offers enable, settings, Reset, Open graph and delete. All
 * writes go through the mesh (mesh/actions.ts).
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ACTION_KINDS,
  actionKind,
  type ActionPreview,
  type PreviewToken,
} from '@vspark/shared/actions';
import { useEditorStore } from '../../../store/editorStore';
import { useSceneNodes } from '../../../mesh/nodes';
import { useComposeLayers } from '../../../mesh/compose';
import { useTrackClips } from '../../../mesh/hooks';
import {
  commitActionCreate,
  commitActionDelete,
  commitActionPatch,
  commitActionReset,
  commitActionSetting,
  editRebuildsGraph,
  statusOf,
  useActionGraphs,
  useProjectActions,
  type ActionRecord,
} from '../../../mesh/actions';
import { HelpButton } from '../../../help/HelpButton';
import { useConfirm } from '../../DialogProvider';
import { HotkeyForm } from './HotkeyForm';
import { buttonStyle, inputStyle } from './styles';

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

function Tokens({ tokens }: { tokens: PreviewToken[] }) {
  const { t } = useTranslation('actions');
  const refName = useRefName();
  return (
    <>
      {tokens.map((tok, i) => {
        const text =
          tok.t === 'text'
            ? tok.text
            : tok.t === 'msg'
              ? t(tok.key, tok.params ?? {})
              : refName(tok.ref, tok.id);
        return (
          <span
            key={i}
            style={{
              marginRight: 5,
              color: tok.t === 'ref' ? '#9bc' : undefined,
            }}
          >
            {text}
          </span>
        );
      })}
    </>
  );
}

export function PreviewView({ preview }: { preview: ActionPreview }) {
  return (
    <div className="vs-action-preview" style={{ fontSize: 11, color: '#999' }}>
      <div style={{ fontFamily: 'monospace', color: '#ddd' }}>
        <Tokens tokens={preview.headline} />
      </div>
      {preview.lines.map((line, i) => (
        <div key={i} style={{ marginTop: 2 }}>
          → <Tokens tokens={line} />
        </div>
      ))}
    </div>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────

/** A render throw in one row must never white-screen the editor. */
class RowBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[actions] row render failed', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Badge({
  className,
  label,
  tip,
  color,
}: {
  className: string;
  label: string;
  tip: string;
  color: string;
}) {
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

function NameField({ action }: { action: ActionRecord }) {
  const { t } = useTranslation('actions');
  const [draft, setDraft] = useState(action.name);
  useEffect(() => setDraft(action.name), [action.name]);
  const commit = () => {
    const name = draft.trim();
    if (name && name !== action.name) commitActionPatch(action.id, { name });
    else setDraft(action.name);
  };
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#888' }}>
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

function ActionRow({
  action,
  graph,
}: {
  action: ActionRecord;
  graph: ReturnType<typeof useActionGraphs>[string] | undefined;
}) {
  const { t } = useTranslation('actions');
  const confirm = useConfirm();
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const [open, setOpen] = useState(false);
  const def = actionKind(action.kind);
  const status = statusOf(action, graph);

  /** A setting edit; a shape edit on a modified graph asks first, because the
   *  rebuild discards the graph edits (decided in the Actions plan). */
  const setSetting = async (path: string, value: unknown) => {
    if (editRebuildsGraph(action, path, value) && status.modified) {
      const ok = await confirm({
        message: t('confirm.rebuild', { name: action.name }),
        confirmLabel: t('confirm.rebuildConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    commitActionSetting(action, path, value);
  };

  const onReset = async () => {
    const ok = await confirm({
      message: t('confirm.reset', { name: action.name }),
      confirmLabel: t('row.reset'),
      danger: true,
    });
    if (ok) commitActionReset(action);
  };

  return (
    <div
      className="vs-action-row"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 8,
        borderRadius: 5,
        background: '#141420',
        border: '1px solid #262636',
        opacity: action.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          className="vs-action-enable"
          checked={action.enabled}
          title={t('row.enabled')}
          aria-label={t('row.enabled')}
          onChange={(e) => commitActionPatch(action.id, { enabled: e.target.checked })}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            color: '#ccc',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {action.name}
        </span>
        {status.modified && (
          <Badge
            className="vs-action-badge-modified"
            label={t('badge.modified')}
            tip={t('badge.modifiedTip')}
            color="#d9a441"
          />
        )}
        {status.templateUpdateAvailable && !status.missingGraph && (
          <Badge
            className="vs-action-badge-template"
            label={t('badge.templateUpdate')}
            tip={t('badge.templateUpdateTip')}
            color="#5aa0d9"
          />
        )}
        {status.missingGraph && (
          <Badge
            className="vs-action-badge-missing"
            label={t('badge.missingGraph')}
            tip={t('badge.missingGraphTip')}
            color="#c66"
          />
        )}
      </div>

      {def && <PreviewView preview={def.preview(action.settings)} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <button
          className="vs-action-settings"
          onClick={() => setOpen((o) => !o)}
          style={{ ...buttonStyle, color: open ? '#ddd' : '#8ac' }}
          aria-expanded={open}
        >
          {open ? t('row.closeSettings') : t('row.settings')}
        </button>
        <button
          className="vs-action-open-graph"
          onClick={() => graph && setActiveLogic(graph.id)}
          disabled={!graph}
          style={buttonStyle}
        >
          {t('row.openGraph')}
        </button>
        <button
          className="vs-action-reset"
          onClick={() => void onReset()}
          disabled={
            !status.modified &&
            !status.templateUpdateAvailable &&
            !status.missingGraph
          }
          title={t('row.resetTip')}
          style={buttonStyle}
        >
          {t('row.reset')}
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="vs-action-delete"
          onClick={() => void commitActionDelete(action.id)}
          title={t('row.delete')}
          aria-label={t('row.delete')}
          style={{ ...buttonStyle, color: '#c66' }}
        >
          ✕
        </button>
      </div>

      {open && (
        <div
          className="vs-action-form"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            paddingTop: 6,
            borderTop: '1px solid #262636',
          }}
        >
          <NameField action={action} />
          {action.kind === 'hotkey' && (
            <HotkeyForm action={action} onSetting={(p, v) => void setSetting(p, v)} />
          )}
        </div>
      )}
    </div>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

export function ActionsPanel({ projectId: propProjectId }: { projectId?: string }) {
  const { t } = useTranslation('actions');
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = propProjectId ?? storeProjectId ?? undefined;
  const actions = useProjectActions(projectId);
  const graphs = useActionGraphs();
  const [adding, setAdding] = useState(false);
  const busy = useRef(false);

  const onAdd = async (kind: string) => {
    if (!projectId || busy.current) return;
    busy.current = true;
    setAdding(false);
    try {
      const sameKind = actions.filter((a) => a.kind === kind).length;
      await commitActionCreate(
        projectId,
        kind,
        `${t(`kinds.${kind}.label`)} ${sameKind + 1}`
      );
    } finally {
      busy.current = false;
    }
  };

  const groups = ACTION_KINDS.map((k) => ({
    def: k,
    items: actions.filter((a) => a.kind === k.kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 10px',
          borderBottom: '1px solid #222',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#ccc' }}>{t('title')}</span>
          <HelpButton topic="actions" anchor="overview" tip={t('help.overview')} size={12} />
        </div>
        <button
          className="vs-action-add"
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
          style={{ ...buttonStyle, color: '#8ac' }}
        >
          + {t('add')}
        </button>
        {adding && (
          <div
            className="vs-action-add-menu"
            role="menu"
            style={{
              position: 'absolute',
              right: 10,
              top: 34,
              zIndex: 10,
              background: '#1a1a26',
              border: '1px solid #333',
              borderRadius: 4,
              padding: 4,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 160,
            }}
          >
            {ACTION_KINDS.map((k) => (
              <button
                key={k.kind}
                role="menuitem"
                className={`vs-action-add-kind vs-action-add-kind-${k.kind}`}
                onClick={() => void onAdd(k.kind)}
                style={{ ...buttonStyle, textAlign: 'left', border: 'none' }}
              >
                {k.icon} {t(`kinds.${k.kind}.label`)}
                <div style={{ fontSize: 9, color: '#777' }}>
                  {t(`kinds.${k.kind}.description`)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {actions.length === 0 && (
          <div style={{ fontSize: 11, color: '#555', padding: 12, textAlign: 'center' }}>
            {t('empty')}
          </div>
        )}
        {groups.map(({ def, items }) => (
          <section key={def.kind} className={`vs-action-group vs-action-group-${def.kind}`}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                color: '#888',
                marginBottom: 6,
              }}
            >
              <span>{def.icon}</span>
              <span>{t(`kinds.${def.kind}.label`)}</span>
              <span style={{ color: '#555' }}>({items.length})</span>
              <HelpButton topic="actions" anchor={def.kind} tip={t(`kinds.${def.kind}.description`)} size={11} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map((a) => (
                <RowBoundary
                  key={a.id}
                  fallback={
                    <div style={{ fontSize: 10, color: '#c66', padding: 8, border: '1px solid #402020', borderRadius: 5 }}>
                      {t('rowError')}
                    </div>
                  }
                >
                  <ActionRow action={a} graph={graphs[a.id]} />
                </RowBoundary>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
