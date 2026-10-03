import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  commitLogicCreate,
  commitLogicDelete,
  commitLogicPatch,
} from '../../mesh/logicWrites';
import { useEditorStore } from '../../store/editorStore';
import { type LogicRecord } from '../../api/client';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { HelpButton } from '../../help/HelpButton';
import { useConfirm, usePrompt } from '../DialogProvider';

/** Inline, expandable list of standalone logic attached to a single scene
 *  node or compose layer — mirrors ClipsSection. Selecting a graph opens it
 *  in the bottom-dock graph canvas. */
export function LogicSection({
  owner,
  flat = false,
  addSignal = 0,
  onCount,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
  /** Render without the standalone bordered box (used inside a merged section). */
  flat?: boolean;
  /** Bumped by a parent to trigger "add graph" (used by the merged section's
   *  unified add menu, since the logic list lives in this component's state). */
  addSignal?: number;
  /** Reports the current graph count to a parent (for a shared empty state). */
  onCount?: (n: number) => void;
}) {
  const { t } = useTranslation('signalGraph');
  const confirm = useConfirm();
  const prompt = usePrompt();
  const setActiveLogic = useEditorStore((s) => s.setActiveLogic);
  const activeLogicId = useEditorStore((s) => s.activeLogicId);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteLogic = clipboardPayload?.kind === 'graph';

  // Fed from the mesh replica. This used to be local state refreshed by a
  // 3-second REST poll, which is why another tab's edit took up to 3s to show
  // and two people editing one graph silently overwrote each other.
  const logic = useEditorStore((s) =>
    Object.values(s.logic)
      .filter(
        (g) =>
          g.ownerKind ===
            (owner.kind === 'node' ? 'scene_node' : 'compose_layer') &&
          g.ownerId === owner.id
      )
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  );
  /** Open context menu state. Null when no menu is currently up. */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    graph: LogicRecord;
  } | null>(null);

  const handleAdd = async () => {
    const name = await prompt({
      title: t('logic.promptName'),
      defaultValue: t('logic.promptDefault'),
      confirmLabel: t('common:actions.create'),
    });
    if (!name?.trim()) return;
    try {
      const created = await commitLogicCreate(
        {
          kind: owner.kind === 'node' ? 'scene_node' : 'compose_layer',
          id: owner.id,
        },
        name.trim()
      );
      openLogic(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failCreate'));
    }
  };

  // Merged-section hooks: trigger add on signal change, report count upward.
  useEffect(() => {
    if (addSignal) void handleAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addSignal]);
  useEffect(() => {
    onCount?.(logic.length);
  }, [logic.length, onCount]);

  const handleDelete = async (g: LogicRecord) => {
    if (
      !(await confirm({
        message: t('logic.confirmDelete', { name: g.name }),
        confirmLabel: t('common:actions.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await commitLogicDelete(g.id);
      if (activeLogicId === g.id) setActiveLogic(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failDelete'));
    }
  };

  const handleToggleEnabled = async (g: LogicRecord) => {
    try {
      commitLogicPatch(g.id, { enabled: !g.enabled });
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
      // Name and descriptor land in one committed write, so a paste is a
      // single undoable action rather than the create + PUT pair it used to be.
      const created = await commitLogicCreate(
        {
          kind: owner.kind === 'node' ? 'scene_node' : 'compose_layer',
          id: owner.id,
        },
        payload.name,
        payload.descriptor
      );
      openLogic(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : t('logic.failPaste'));
    }
  };

  return (
    <div
      style={
        flat
          ? { overflow: 'hidden' }
          : {
              marginLeft: 28,
              marginRight: 4,
              marginBottom: 4,
              background: '#111',
              borderRadius: 4,
              border: '1px solid #222',
              overflow: 'hidden',
            }
      }
    >
      {!flat && logic.length === 0 && (
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
      {!flat && (
      <div
        style={{
          padding: '3px 6px',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
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
      )}
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
      label: args.graph.enabled
        ? args.t('logic.disable')
        : args.t('logic.enable'),
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
