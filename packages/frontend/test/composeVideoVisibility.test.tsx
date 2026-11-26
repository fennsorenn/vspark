/**
 * A video layer follows its layer's visibility: the <video> must not set an
 * explicit `visibility: visible`, which would override the layer's own
 * `visibility: hidden` and show the first frame of a hidden, not-yet-played
 * video.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders } from './helpers/render';
import { ComposeLayerStack } from '../src/components/editor/ComposeLayerStack';
import type { AssetFile, ComposeLayerRecord } from '../src/api/client';

const asset: AssetFile = {
  id: 'vid',
  projectId: 'p1',
  name: 'clip.mp4',
  storedPath: 'clip.mp4',
  url: '/assets/clip.mp4',
  mimeType: 'video/mp4',
  kind: 'video',
  metadata: null,
};

const layer = (visible: boolean): ComposeLayerRecord => ({
  id: 'l1',
  projectId: 'p1',
  rootComposeSceneId: 'cs1',
  cameraNodeId: null,
  parentId: null,
  name: 'Video',
  kind: 'video',
  assetId: 'vid',
  config: { autoplay: false, loop: false, onEnd: 'hide' },
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  anchorH: 'left',
  anchorV: 'top',
  orderKey: 'a',
  visible,
});

/** CSS `visibility` as a browser resolves it: the nearest element that sets
 *  it to something other than `inherit` decides (jsdom's computed style
 *  doesn't resolve inheritance). */
function resolvedVisibility(el: HTMLElement | null): string {
  for (let e = el; e; e = e.parentElement) {
    const v = e.style.visibility;
    if (v && v !== 'inherit') return v;
  }
  return 'visible';
}

describe('compose video layer visibility', () => {
  it.each([true, false])(
    'the video follows the layer visibility (visible=%s)',
    (visible) => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
      const { container } = renderWithProviders(
        <ComposeLayerStack layers={[layer(visible)]} assets={[asset]} />
      );
      const video = container.querySelector('video')!;
      expect(video).toBeTruthy();
      expect(resolvedVisibility(video)).toBe(visible ? 'visible' : 'hidden');
    }
  );
});
