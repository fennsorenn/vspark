import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditorStore } from '../../store/editorStore';
import { api, type LogicRecord } from '../../api/client';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { HelpButton } from '../../help/HelpButton';

/** Inline, expandable list of standalone logic attached to a single scene
 *  node or compose layer — mirrors ClipsSection. Selecting a graph opens it
 *  in the bottom-dock graph canvas. */
export function LogicSection({
  owner,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
}) {
  const { t } = useTranslation('signalGraph');
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const activeLogicId = useEditorStore((s) => s.activeLogicId);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteLogic = clipboardPayload?.kind === 'graph';

  const [logic, setLogic] = useState<LogicRecord[]>([]);
  /** Open context menu state. Null when no menu is currently up. */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    graph: LogicRecord;
  } | null>(null);

  const fetch = () => {
    const call =
      owner.kind === 'node'
        ? api.getNodeLogic(owner.id)
        : api.getLayerLogic(owner.id);
    call.then(setLogic).catch(() => {});
  };

  // Refresh on owner change + every few seconds (cheap, matches the
  // LogicListPanel polling cadence).
  useEffect(() => {
    fetch();
    const iv = setInterval(fetch, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, owner.id]);

  const handleAdd = async () => {
    const name = window.prompt(t('logic.promptName'), t('logic.promptDefault'));
    if (!name?.trim()) return;
    try {
      const created =
        owner.kind === 'node'
          ? await api.createNodeLogic(owner.id, name.trim())
          : await api.createLayerLogic(owner.id, name.trim());
      setLogic((prev) => [...prev, created]);
      openLogic(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failCreate'));
    }
  };

  const handleDelete = async (g: LogicRecord) => {
    if (!window.confirm(t('logic.confirmDelete', { name: g.name }))) return;
    try {
      await api.deleteLogic(g.id);
      setLogic((prev) => prev.filter((x) => x.id !== g.id));
      if (activeLogicId === g.id) setActiveLogic(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failDelete'));
    }
  };

  const handleToggleEnabled = async (g: LogicRecord) => {
    try {
      const updated = await api.updateLogic(g.id, { enabled: !g.enabled });
      setLogic((prev) => prev.map((x) => (x.id === g.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failToggle'));
    }
  };

  // Opening a graph swaps the main canvas to the SignalGraphCanvas (the
  // editor's main pane). Clearing activeLogic (e.g. selecting a non-graph
  // tab in the left dock) returns to the viewport.
  const openLogic = (id: string) => setActiveLogic(id);

  const handleCopy = async (g: LogicRecord) => {
    // LogicRecord.descriptor lacks the wrapper fields (id, label, readonly)
    // that the canvas expects internally, but those are reconstructed on
    // paste — we only need the nodes + edges + name.
    await copyToClipboard(
      {
        kind: 'graph',
        name: g.name,
        descriptor: g.descriptor,
        sourceOwnerKind: owner.kind === 'node' ? 'scene_node' : 'compose_layer',
      },
      setClipboard
    );
  };

  const handlePaste = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'graph') return;
    try {
      const created =
        owner.kind === 'node'
          ? await api.createNodeLogic(owner.id, payload.name)
          : await api.createLayerLogic(owner.id, payload.name);
      // Push the descriptor onto the new graph in a follow-up PUT — the
      // create endpoint only takes a name.
      const updated = await api.updateLogic(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
      setLogic((prev) => [...prev, updated]);
      openLogic(updated.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failPaste'));
    }
  };

  return (
    <div
      style={{
        marginLeft: 28,
        marginRight: 4,
        marginBottom: 4,
        background: '#111',
        borderRadius: 4,
        border: '1px solid #222',
        overflow: 'hidden',
      }}
    >
      {logic.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          {t('logic.empty')}
        </div>
      )}
      {logic.map((g) => {
        const isActive = activeLogicId === g.id;
        return (
          <div
            key={g.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid #1a1a1a',
              fontSize: 12,
              cursor: 'pointer',
              background: isActive ? '#1a3a5a' : 'transparent',
            }}
            onClick={() => openLogic(g.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, graph: g });
            }}
          >
            <span
              style={{
                fontSize: 13,
                color: g.enabled ? '#7aa86a' : '#555',
              }}
              title={g.enabled ? t('logic.enabled') : t('logic.disabled')}
            >
              ⊕
            </span>
            <span
              style={{
                flex: 1,
                color: isActive ? '#fff' : g.enabled ? '#ccc' : '#666',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {g.name}
            </span>
            <button
              title={g.enabled ? t('logic.disable') : t('logic.enable')}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: g.enabled ? '#7aa86a' : '#555',
                fontSize: 11,
                padding: '0 4px',
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleEnabled(g);
              }}
            >
              {g.enabled ? '●' : '○'}
            </button>
          </div>
        );
      })}
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          onClick={handleAdd}
          style={{
            background: 'none',
            border: '1px dashed #2a2a2a',
            borderRadius: 4,
            color: '#888',
            cursor: 'pointer',
            fontSize: 11,
            padding: '3px 8px',
            flex: 1,
            textAlign: 'left',
          }}
        >
          {t('logic.addButton')}
        </button>
        {canPasteLogic && (
          <button
            onClick={handlePaste}
            title={t('logic.pasteTitle')}
            style={{
              background: 'none',
              border: '1px dashed #3a5a4a',
              borderRadius: 4,
              color: '#9bc090',
              cursor: 'pointer',
              fontSize: 11,
              padding: '3px 8px',
              textAlign: 'left',
            }}
          >
            {t('logic.pasteButton')}
          </button>
        )}
        <HelpButton
          topic="logic"
          anchor="automations"
          tip={t('help.automations')}
          size={12}
        />
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildLogicRowMenu({
            graph: ctxMenu.graph,
            t,
            onCopy: () => void handleCopy(ctxMenu.graph),
            onToggleEnabled: () => handleToggleEnabled(ctxMenu.graph),
            onDelete: () => handleDelete(ctxMenu.graph),
          })}
        />
      )}
    </div>
  );
}

/** Build the per-graph-row menu. Pulled out so the same shape is reused
 *  (and trivially extended) without inlining a 30-line array literal at the
 *  call site. */
function buildLogicRowMenu(args: {
  graph: LogicRecord;
  t: (key: string) => string;
  onCopy: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  return [
    { kind: 'item', label: args.t('logic.ctxCopy'), onClick: args.onCopy },
    {
      kind: 'item',
      label: args.graph.enabled ? args.t('logic.disable') : args.t('logic.enable'),
      onClick: args.onToggleEnabled,
    },
    { kind: 'divider' },
    {
      kind: 'item',
      label: args.t('logic.ctxDelete'),
      onClick: args.onDelete,
      danger: true,
    },
  ];
}
