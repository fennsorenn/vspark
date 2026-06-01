import { useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { api, type TrackClipRecord } from '../../api/client';
import { ContextMenu } from './ContextMenu';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';

/** Inline, expandable list of track clips owned by a single scene node or
 *  compose layer — mirrors the components/effects sub-sections in the scene
 *  tree. Selecting a clip opens it in the bottom-dock timeline editor.
 *  Right-click a clip row for Copy / Delete; a section-level Paste button
 *  appears when the clipboard holds a clip. */
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
  const clipboardPayload = useEditorStore((s) => s.clipboardPayload);
  const setClipboard = useEditorStore((s) => s.setClipboard);
  const canPasteClip = clipboardPayload?.kind === 'track-clip';
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    clip: TrackClipRecord;
  } | null>(null);

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

  const handleCopyClip = async (clip: TrackClipRecord) => {
    // We snapshot top-level clip fields + lanes + keyframes (excluding any
    // ids — they get re-minted on paste). Source owner id is carried so
    // paste can decide which lane targets to retarget; sourceOwnerKind
    // resolves which owner field on the source row applied.
    const sourceOwnerId = clip.ownerNodeId ?? clip.ownerLayerId ?? '';
    const sourceOwnerKind = clip.ownerNodeId ? 'scene_node' : 'compose_layer';
    await copyToClipboard(
      {
        kind: 'track-clip',
        sourceOwnerId,
        sourceOwnerKind,
        clip: {
          name: clip.name,
          duration: clip.duration,
          loop: clip.loop,
          mode: clip.mode,
          autoplay: clip.autoplay,
          lanes: clip.lanes.map((lane) => ({
            // lane.id and lane.clipId are intentionally re-minted on paste.
            id: '',
            clipId: '',
            targetKind: lane.targetKind,
            targetId: lane.targetId,
            paramPath: lane.paramPath,
            defaultValue: lane.defaultValue,
            keyframes: lane.keyframes.map((kf) => ({
              ...kf,
              id: '',
            })),
          })),
        },
      },
      setClipboard
    );
  };

  const handlePasteClip = async () => {
    const payload = await pasteFromClipboard(clipboardPayload);
    if (!payload || payload.kind !== 'track-clip') return;
    const destOwnerKind: 'scene_node' | 'compose_layer' =
      owner.kind === 'node' ? 'scene_node' : 'compose_layer';
    try {
      // 1. Create the empty clip row.
      const body = {
        name: payload.clip.name,
        duration: payload.clip.duration,
        loop: payload.clip.loop,
        mode: payload.clip.mode,
        autoplay: payload.clip.autoplay,
      };
      const created =
        owner.kind === 'node'
          ? await api.createTrackClipForNode(owner.id, body)
          : await api.createTrackClipForLayer(owner.id, body);
      // 2. For each lane: rewrite targets that pointed at the source owner
      //    to point at the new owner (and switch kind to match the new owner
      //    kind). Lanes targeting other entities keep their original target.
      for (const lane of payload.clip.lanes) {
        const isOwnerLane = lane.targetId === payload.sourceOwnerId;
        const targetKind = isOwnerLane ? destOwnerKind : lane.targetKind;
        const targetId = isOwnerLane ? owner.id : lane.targetId;
        const newLane = await api.createTrackClipLane(created.id, {
          targetKind,
          targetId,
          paramPath: lane.paramPath,
          defaultValue: lane.defaultValue,
        });
        if (lane.keyframes.length > 0) {
          await api.replaceTrackClipKeyframes(
            newLane.id,
            lane.keyframes.map((kf) => ({
              t: kf.t,
              value: kf.value,
              easing: kf.easing,
              inHandleTFraction: kf.inHandleTFraction,
              inHandleVFraction: kf.inHandleVFraction,
              outHandleTFraction: kf.outHandleTFraction,
              outHandleVFraction: kf.outHandleVFraction,
            }))
          );
        }
      }
      // 3. Reload the full clip (with its lanes + keyframes) so the local
      //    store reflects the paste. The lane / keyframe create+replace
      //    calls don't write through addTrackClip, and the WS broadcasts
      //    for those individual rows may arrive out of order — fetch a
      //    consistent snapshot ourselves.
      const fresh =
        owner.kind === 'node'
          ? await api.getTrackClipsForNode(owner.id)
          : await api.getTrackClipsForLayer(owner.id);
      const reloaded = fresh.find((c) => c.id === created.id);
      if (reloaded) addTrackClip(reloaded);
      selectTrackClip(created.id);
      setBottomTab('clips');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to paste clip');
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
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, clip });
            }}
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
          + Add Clip
        </button>
        {canPasteClip && (
          <button
            onClick={handlePasteClip}
            title="Paste the clip from clipboard onto this owner"
            style={{
              background: 'none',
              border: '1px dashed #3a5a4a',
              borderRadius: 4,
              color: '#9bc090',
              cursor: 'pointer',
              fontSize: 11,
              padding: '3px 8px',
            }}
          >
            ⧉ Paste Clip
          </button>
        )}
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              kind: 'item',
              label: 'Copy clip',
              onClick: () => void handleCopyClip(ctxMenu.clip),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: 'Delete clip',
              onClick: () => void handleRemove(ctxMenu.clip.id),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}
