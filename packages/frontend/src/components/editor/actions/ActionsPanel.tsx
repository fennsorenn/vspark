/**
 * Actions panel (left-dock tab) — the list of the project's actions:
 * project-level workflows configured by a settings form, each backed by a
 * stored, editable Logic graph generated from its kind's template. See
 * dev-notes/modules/actions.md.
 *
 * Grouped by kind; each row previews its most important settings (the kind
 * declares the preview in @vspark/shared/actions), shows Modified / template
 * update badges and an enable toggle. Clicking a row opens its settings in the
 * main view (ActionEditor). All writes go through the mesh (mesh/actions.ts).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTION_KINDS, actionKind } from '@vspark/shared/actions';
import { useEditorStore } from '../../../store/editorStore';
import {
  commitActionCreate,
  commitActionPatch,
  statusOf,
  useActionGraphs,
  useProjectActions,
  type ActionRecord,
} from '../../../mesh/actions';
import { HelpButton } from '../../../help/HelpButton';
import { PreviewLine, RenderBoundary, StatusBadges } from './parts';
import { buttonStyle } from './styles';

// ── row ──────────────────────────────────────────────────────────────────────

function ActionRow({
  action,
  graph,
  selected,
  onSelect,
}: {
  action: ActionRecord;
  graph: ReturnType<typeof useActionGraphs>[string] | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('actions');
  const def = actionKind(action.kind);
  const status = statusOf(action, graph);
  return (
    <div
      className="vs-action-row"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 6px',
        borderRadius: 4,
        cursor: 'pointer',
        background: selected ? '#1c2233' : '#141420',
        border: `1px solid ${selected ? '#3a5a8a' : '#262636'}`,
        opacity: action.enabled ? 1 : 0.55,
      }}
    >
      <input
        type="checkbox"
        className="vs-action-enable"
        checked={action.enabled}
        title={t('row.enabled')}
        aria-label={t('row.enabled')}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          commitActionPatch(action.id, { enabled: e.target.checked })
        }
        style={{ margin: 0, flexShrink: 0 }}
      />
      <span
        title={action.name}
        style={{
          flex: '0 1 auto',
          maxWidth: '45%',
          fontSize: 12,
          color: '#ccc',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {action.name}
      </span>
      {def ? (
        <PreviewLine preview={def.preview(action.settings)} />
      ) : (
        <span style={{ flex: 1 }} />
      )}
      <StatusBadges status={status} compact />
    </div>
  );
}

// ── panel ────────────────────────────────────────────────────────────────────

export function ActionsPanel({
  projectId: propProjectId,
}: {
  projectId?: string;
}) {
  const { t } = useTranslation('actions');
  const storeProjectId = useEditorStore((s) => s.projectId);
  const projectId = propProjectId ?? storeProjectId ?? undefined;
  const actions = useProjectActions(projectId);
  const graphs = useActionGraphs();
  const [adding, setAdding] = useState(false);
  const activeId = useEditorStore((s) => s.activeActionId);
  const setActiveAction = useEditorStore((s) => s.setActiveAction);
  const busy = useRef(false);

  const onAdd = async (kind: string) => {
    if (!projectId || busy.current) return;
    busy.current = true;
    setAdding(false);
    try {
      const sameKind = actions.filter((a) => a.kind === kind).length;
      const created = await commitActionCreate(
        projectId,
        kind,
        `${t(`kinds.${kind}.label`)} ${sameKind + 1}`
      );
      // The new action opens in the main view right away.
      if (created) setActiveAction(created.id);
    } finally {
      busy.current = false;
    }
  };

  const groups = ACTION_KINDS.map((k) => ({
    def: k,
    items: actions.filter((a) => a.kind === k.kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
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
          <span style={{ fontSize: 12, fontWeight: 600, color: '#ccc' }}>
            {t('title')}
          </span>
          <HelpButton
            topic="actions"
            anchor="overview"
            tip={t('help.overview')}
            size={12}
          />
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
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {actions.length === 0 && (
          <div
            style={{
              fontSize: 11,
              color: '#555',
              padding: 12,
              textAlign: 'center',
            }}
          >
            {t('empty')}
          </div>
        )}
        {groups.map(({ def, items }) => (
          <section
            key={def.kind}
            className={`vs-action-group vs-action-group-${def.kind}`}
          >
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
              <HelpButton
                topic="actions"
                anchor={def.kind}
                tip={t(`kinds.${def.kind}.description`)}
                size={11}
              />
              <div style={{ flex: 1 }} />
              <button
                className="vs-action-group-add"
                onClick={() => void onAdd(def.kind)}
                title={t('addOfKind', { kind: t(`kinds.${def.kind}.label`) })}
                aria-label={t('addOfKind', {
                  kind: t(`kinds.${def.kind}.label`),
                })}
                style={{
                  ...buttonStyle,
                  color: '#8ac',
                  padding: '0 6px',
                  textTransform: 'none',
                }}
              >
                +
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {items.map((a) => (
                <RenderBoundary
                  key={a.id}
                  fallback={
                    <div
                      style={{
                        fontSize: 10,
                        color: '#c66',
                        padding: 8,
                        border: '1px solid #402020',
                        borderRadius: 5,
                      }}
                    >
                      {t('rowError')}
                    </div>
                  }
                >
                  <ActionRow
                    action={a}
                    graph={graphs[a.id]}
                    selected={a.id === activeId}
                    onSelect={() => setActiveAction(a.id)}
                  />
                </RenderBoundary>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
