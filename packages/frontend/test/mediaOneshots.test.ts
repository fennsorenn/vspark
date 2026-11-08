/**
 * Media one-shots on the client: a sound cue plays the collection asset on a
 * transient audio element; a play command carrying an asset swaps that video
 * into the target's player (playSource) instead of plain play.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEditorStore } from '../src/store/editorStore';
import { playSoundCue } from '../src/mesh/soundCues';
import {
  dispatchMediaCommand,
  registerMedia,
  type MediaHandle,
} from '../src/components/editor/mediaRegistry';
import type { AssetFile } from '../src/api/client';

const asset = (id: string, kind: AssetFile['kind']): AssetFile => ({
  id,
  projectId: 'p1',
  name: id,
  storedPath: id,
  url: `/assets/${id}`,
  mimeType: kind === 'audio' ? 'audio/mpeg' : 'video/mp4',
  kind,
  metadata: null,
});

beforeEach(() => {
  useEditorStore.setState({
    assets: [asset('ding', 'audio'), asset('clip', 'video')],
  });
});

describe('sound cues', () => {
  it('plays the asset at the cue volume', () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    const el = playSoundCue({
      id: 'p1',
      projectId: 'p1',
      assetId: 'ding',
      volume: 0.4,
      cueId: 'c1',
    });
    expect(el?.src).toContain('/assets/ding');
    expect(el?.volume).toBeCloseTo(0.4);
    expect(play).toHaveBeenCalled();
    play.mockRestore();
  });

  it('ignores an asset this tab does not know', () => {
    expect(
      playSoundCue({ id: 'p1', projectId: 'p1', assetId: 'nope', cueId: 'c' })
    ).toBeNull();
  });
});

describe('video swap', () => {
  const handle = (): MediaHandle & {
    playSource: ReturnType<typeof vi.fn>;
  } => ({
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    mute: vi.fn(),
    unmute: vi.fn(),
    playSource: vi.fn(),
  });

  it('a play with an asset plays that video instead', () => {
    const h = handle();
    const off = registerMedia('v1', h);
    dispatchMediaCommand('v1', { action: 'play', assetId: 'clip' });
    expect(h.playSource).toHaveBeenCalledWith('/assets/clip');
    expect(h.play).not.toHaveBeenCalled();
    off();
  });

  it('an unknown asset falls back to the plain action', () => {
    const h = handle();
    const off = registerMedia('v1', h);
    dispatchMediaCommand('v1', { action: 'restart', assetId: 'nope' });
    expect(h.restart).toHaveBeenCalled();
    expect(h.playSource).not.toHaveBeenCalled();
    off();
  });
});
