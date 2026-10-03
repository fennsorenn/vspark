import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Clapperboard } from 'lucide-react';
import { useEditorStore } from '../../store/editorStore';
import { type TrackClipRecord } from '../../api/client';
import {
  commitClipCreate,
  commitClipDelete,
  commitEvent,
  commitKeyframe,
  commitLaneCreate,
} from '../../mesh/clipWrites';
import { ContextMenu } from './ContextMenu';
import { copyToClipboard, pasteFromClipboard } from '../../clipboard';
import { HelpButton } from '../../help/HelpButton';

/** Inline, expandable list of track clips owned by a single scene node or
 *  compose layer — mirrors the components/effects sub-sections in the scene
 *  tree. Selecting a clip opens it in the bottom-dock timeline editor.
 *  Right-click a clip row for Copy / Delete; a section-level Paste button
 *  appears when the clipboard holds a clip. */
export function ClipsSection({
  owner,
  flat = false,
}: {
  owner: { kind: 'node'; id: string } | { kind: 'layer'; id: string };
  /** Render without the standalone bordered box (used inside a merged section). */
  flat?: boolean;
}) {
  const { t } = useTranslation('clips');
  const trackClips = useEditorStore((s) => s.trackClips);
  const selectedTrackClipId = useEditorStore((s) => s.selectedTrackClipId);
  const selectTrackClip = useEditorStore((s) => s.selectTrackClip);
  const setBottomTab = useEditorStore((s) => s.setBottomTab);
  const playback = useEditorStore((s) => s.clipPlayback);
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

  const ownerRef = () => ({
    kind:
      owner.kind === 'node'
        ? ('scene_node' as const)
        : ('compose_layer' as const),
    id: owner.id,
  });

  const handleAdd = async () => {
    try {
      const clip = await commitClipCreate(ownerRef(), {
        name: 'Clip',
        duration: 2,
      });
      selectTrackClip(clip.id);
      setBottomTab('clips');
    } catch {
      /* non-fatal */
    }
  };

  const handleRemove = async (id: string) => {
    await commitClipDelete(id);
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
          events: clip.events.map((e) => ({ ...e, id: '' })),
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
      // 1. Create the empty clip.
      const created = await commitClipCreate(ownerRef(), {
        name: payload.clip.name,
        duration: payload.clip.duration,
        loop: payload.clip.loop,
        mode: payload.clip.mode,
      });
      // 2. For each lane: rewrite targets that pointed at the source owner
      //    to point at the new owner (and switch kind to match the new owner
      //    kind). Lanes targeting other entities keep their original target.
      for (const lane of payload.clip.lanes) {
        const isOwnerLane = lane.targetId === payload.sourceOwnerId;
        const targetKind = isOwnerLane ? destOwnerKind : lane.targetKind;
        const targetId = isOwnerLane ? owner.id : lane.targetId;
        const newLane = await commitLaneCreate(created.id, {
          targetKind,
          targetId,
          paramPath: lane.paramPath,
          defaultValue: lane.defaultValue,
        });
        // Fresh keyframe ids: the copy carries the source's, and two clips
        // must not share element ids (the mesh containment index keys by id
        // alone, and a paste into the same clip would collide with itself).
        for (const kf of lane.keyframes)
          commitKeyframe(created.id, newLane.id, {
            ...kf,
            id: crypto.randomUUID(),
          });
      }
      // 2b. Recreate event markers, retargeting owner-pointed markers like lanes.
      for (const e of payload.clip.events ?? []) {
        const isOwner = e.targetId === payload.sourceOwnerId;
        commitEvent(created.id, {
          ...e,
          id: crypto.randomUUID(),
          targetKind: isOwner ? destOwnerKind : e.targetKind,
          targetId: isOwner ? owner.id : e.targetId,
        });
      }
      // No reload: every write above landed in the replica, and the feeder
      // mirrors it into the store. (The old REST path needed one, because the
      // lane and keyframe calls did not write through the store at all.)
      selectTrackClip(created.id);
      setBottomTab('clips');
    } catch (e) {
      alert(e instanceof Error ? e.message : t('section.errors.pasteFailed'));
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
      {!flat && clips.length === 0 && (
        <div
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: '#444',
            fontStyle: 'italic',
          }}
        >
          {t('empty.noClips')}
        </div>
      )}
      {clips.map((clip) => {
        const isSelected = selectedTrackClipId === clip.id;
        const playing = playback[clip.id]?.state === 'playing';
        return (
          <div
            key={clip.id}
            className="vs-clip-row"
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
            <span style={{ display: 'inline-flex' }}>
              {playing ? <Play size={13} /> : <Clapperboard size={13} />}
            </span>
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
      {!flat && (
      <div style={{ padding: '3px 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
        <button
          className="vs-clip-add"
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
          {t('section.addClip')}
        </button>
        {canPasteClip && (
          <button
            className="vs-clip-paste"
            onClick={handlePasteClip}
            title={t('section.pasteClipTitle')}
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
            {t('section.pasteClip')}
          </button>
        )}
        <HelpButton
          topic="track-clips"
          anchor="what"
          tip={t('help.clipsSection')}
          size={12}
        />
      </div>
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              kind: 'item',
              label: t('section.ctx.copyClip'),
              onClick: () => void handleCopyClip(ctxMenu.clip),
            },
            { kind: 'divider' },
            {
              kind: 'item',
              label: t('section.ctx.deleteClip'),
              onClick: () => void handleRemove(ctxMenu.clip.id),
              danger: true,
            },
          ]}
        />
      )}
    </div>
  );
}
