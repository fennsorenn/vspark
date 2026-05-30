import { useEffect, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { api, type GraphRecord } from '../../api/client';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';

/** Inline, expandable list of standalone graphs attached to a single scene
 *  node or compose layer — mirrors ClipsSection. Selecting a graph opens it
 *  in the bottom-dock graph canvas. */
export function GraphsSection({
  owner,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
}) {
  const setActiveGraph = useEditorStore((s) => s.setActiveGraph);
  const activeGraphId = useEditorStore((s) => s.activeGraphId);
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteGraph = clipboardPayload?.kind === 'graph';

  const [graphs, setGraphs] = useState<GraphRecord[]>([]);

  const fetch = () => {
    const call =
      owner.kind === 'node'
        ? api.getNodeGraphs(owner.id)
        : api.getLayerGraphs(owner.id);
    call.then(setGraphs).catch(() => {});
  };

  // Refresh on owner change + every few seconds (cheap, matches the
  // GraphListPanel polling cadence).
  useEffect(() => {
    fetch();
    const iv = setInterval(fetch, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner.kind, owner.id]);

  const handleAdd = async () => {
    const name = window.prompt('New graph name:', 'Untitled Graph');
    if (!name?.trim()) return;
    try {
      const created =
        owner.kind === 'node'
          ? await api.createNodeGraph(owner.id, name.trim())
          : await api.createLayerGraph(owner.id, name.trim());
      setGraphs((prev) => [...prev, created]);
      openGraph(created.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create graph');
    }
  };

  const handleDelete = async (g: GraphRecord) => {
    if (!window.confirm(`Delete graph "${g.name}"?`)) return;
    try {
      await api.deleteGraph(g.id);
      setGraphs((prev) => prev.filter((x) => x.id !== g.id));
      if (activeGraphId === g.id) setActiveGraph(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete graph');
    }
  };

  const handleToggleEnabled = async (g: GraphRecord) => {
    try {
      const updated = await api.updateGraph(g.id, { enabled: !g.enabled });
      setGraphs((prev) => prev.map((x) => (x.id === g.id ? updated : x)));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to toggle graph');
    }
  };

  // Opening a graph swaps the main canvas to the SignalGraphCanvas (the
  // editor's main pane). Clearing activeGraph (e.g. selecting a non-graph
  // tab in the left dock) returns to the viewport.
  const openGraph = (id: string) => setActiveGraph(id);

  const handleCopy = async (g: GraphRecord) => {
    // GraphRecord.descriptor lacks the wrapper fields (id, label, readonly)
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
          ? await api.createNodeGraph(owner.id, payload.name)
          : await api.createLayerGraph(owner.id, payload.name);
      // Push the descriptor onto the new graph in a follow-up PUT — the
      // create endpoint only takes a name.
      const updated = await api.updateGraph(created.id, {
        descriptor: payload.descriptor,
        enabled: true,
      });
      setGraphs((prev) => [...prev, updated]);
      openGraph(updated.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste graph');
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
          No graphs
        </div>
      )}
      {graphs.map((g) => {
        const isActive = activeGraphId === g.id;
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
            <button
              title="Copy graph (paste anywhere with Paste Graph)"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#666',
                fontSize: 11,
                padding: '0 4px',
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                void handleCopy(g);
              }}
            >
              ⧉
            </button>
            <button
              title="Delete graph"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#555',
                fontSize: 14,
                padding: '0 2px',
                lineHeight: 1,
              }}
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(g);
              }}
            >
              ×
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
          + Add Graph
        </button>
        {canPasteGraph && (
          <button
            onClick={handlePaste}
            title="Paste the graph from clipboard onto this owner"
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
            ⧉ Paste Graph
          </button>
        )}
      </div>
    </div>
  );
}
