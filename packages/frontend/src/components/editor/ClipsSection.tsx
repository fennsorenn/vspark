import { useEditorStore } from '../../store/editorStore';
import { api } from '../../api/client';

/** Inline, expandable list of track clips owned by a single scene node or
 *  compose layer — mirrors the components/effects sub-sections in the scene
 *  tree. Selecting a clip opens it in the bottom-dock timeline editor. */
export function ClipsSection({
  owner,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
}) {
  const trackClips = useEditorStore((s) => s.trackClips);
  const selectedTrackClipId = useEditorStore((s) => s.selectedTrackClipId);
  const selectTrackClip = useEditorStore((s) => s.selectTrackClip);
  const addTrackClip = useEditorStore((s) => s.addTrackClip);
  const removeTrackClip = useEditorStore((s) => s.removeTrackClip);
  const setBottomTab = useEditorStore((s) => s.setBottomTab);
  const playback = useEditorStore((s) => s.trackClipPlayback);

  const clips = trackClips.filter((c) =>
    owner.kind === 'node'
      ? c.ownerNodeId === owner.id
      : c.ownerLayerId === owner.id
  );

  const handleAdd = async () => {
    const body = { name: 'Clip', duration: 2 };
    try {
      const clip =
        owner.kind === 'node'
          ? await api.createTrackClipForNode(owner.id, body)
          : await api.createTrackClipForLayer(owner.id, body);
      addTrackClip(clip);
      selectTrackClip(clip.id);
      setBottomTab('clips');
    } catch {
      /* non-fatal */
    }
  };

  const handleRemove = async (id: string) => {
    removeTrackClip(id);
    await api.deleteTrackClip(id).catch(() => {});
  };

  const openClip = (id: string) => {
    selectTrackClip(id);
    setBottomTab('clips');
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
      {clips.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          No clips
        </div>
      )}
      {clips.map((clip) => {
        const isSelected = selectedTrackClipId === clip.id;
        const playing = !!playback[clip.id];
        return (
          <div
            key={clip.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderBottom: '1px solid #1a1a1a',
              fontSize: 12,
              cursor: 'pointer',
              background: isSelected ? '#1a3a5a' : 'transparent',
            }}
            onClick={() => openClip(clip.id)}
          >
            <span style={{ fontSize: 13 }}>{playing ? '▶' : '🎬'}</span>
            <span
              style={{
                flex: 1,
                color: isSelected ? '#fff' : '#ccc',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {clip.name}
            </span>
            <button
              title="Delete clip"
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
                handleRemove(clip.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <div style={{ padding: '3px 6px' }}>
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
            width: '100%',
            textAlign: 'left',
          }}
        >
          + Add Clip
        </button>
      </div>
    </div>
  );
}
