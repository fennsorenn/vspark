import { useEffect, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { api, type AutomationRecord } from '../../api/client';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

/** Inline, expandable list of standalone graphs attached to a single scene
 *  node or compose layer — mirrors ClipsSection. Selecting a graph opens it
 *  in the bottom-dock graph canvas. */
export function AutomationsSection({
  owner,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
}) {
  const setActiveAutomation = useEditorStore((s) => s.setActiveAutomation);
  const activeAutomationId = useEditorStore((s) => s.activeAutomationId);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteGraph = clipboardPayload?.kind === 'graph';

  const [graphs, setGraphs] = useState<AutomationRecord[]>([]);
  /** Open context menu state. Null when no menu is currently up. */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    graph: AutomationRecord;
  } | null>(null);

  const fetch = () => {
    const call =
      owner.kind === 'node'
        ? api.getNodeAutomations(owner.id)
        : api.getLayerAutomations(owner.id);
    call.then(setGraphs).catch(() => {});
  };

  // Refresh on owner change + every few seconds (cheap, matches the
  // AutomationListPanel polling cadence).
  useEffect(() => {
    fetch();
    const iv = setInterval(fetch, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, owner.id]);

  const handleAdd = async () => {
    const name = window.prompt('New automation name:', 'Untitled Automation');
    if (!name?.trim()) return;
    try {
      const created =
        owner.kind === 'node'
          ? await api.createNodeAutomation(owner.id, name.trim())
          : await api.createLayerAutomation(owner.id, name.trim());
      setGraphs((prev) => [...prev, created]);
      openGraph(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create automation');
    }
  };

  const handleDelete = async (g: AutomationRecord) => {
    if (!window.confirm(`Delete automation "${g.name}"?`)) return;
    try {
      await api.deleteAutomation(g.id);
      setGraphs((prev) => prev.filter((x) => x.id !== g.id));
      if (activeAutomationId === g.id) setActiveAutomation(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete automation');
    }
  };

  const handleToggleEnabled = async (g: AutomationRecord) => {
    try {
      const updated = await api.updateAutomation(g.id, { enabled: !g.enabled });
      setGraphs((prev) => prev.map((x) => (x.id === g.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to toggle automation');
    }
  };

  // Opening a graph swaps the main canvas to the SignalGraphCanvas (the
  // editor's main pane). Clearing activeAutomation (e.g. selecting a non-graph
  // tab in the left dock) returns to the viewport.
  const openGraph = (id: string) => setActiveAutomation(id);

  const handleCopy = async (g: AutomationRecord) => {
    // AutomationRecord.descriptor lacks the wrapper fields (id, label, readonly)
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
          ? await api.createNodeAutomation(owner.id, payload.name)
          : await api.createLayerAutomation(owner.id, payload.name);
      // Push the descriptor onto the new graph in a follow-up PUT — the
      // create endpoint only takes a name.
      const updated = await api.updateAutomation(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
      setGraphs((prev) => [...prev, updated]);
      openGraph(updated.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste automation');
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
      {graphs.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          No automations
        </div>
      )}
      {graphs.map((g) => {
        const isActive = activeAutomationId === g.id;
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
            onClick={() => openGraph(g.id)}
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
              title={g.enabled ? 'Enabled' : 'Disabled'}
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
              title={g.enabled ? 'Disable' : 'Enable'}
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
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6 }}>
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
          + Add Automation
        </button>
        {canPasteGraph && (
          <button
            onClick={handlePaste}
            title="Paste the automation from clipboard onto this owner"
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
            ⧉ Paste Automation
          </button>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={buildAutomationRowMenu({
            graph: ctxMenu.graph,
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
function buildAutomationRowMenu(args: {
  graph: AutomationRecord;
  onCopy: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}): ContextMenuItem[] {
  return [
    { kind: 'item', label: 'Copy graph', onClick: args.onCopy },
    {
      kind: 'item',
      label: args.graph.enabled ? 'Disable' : 'Enable',
      onClick: args.onToggleEnabled,
    },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Delete',
      onClick: args.onDelete,
      danger: true,
    },
  ];
}
