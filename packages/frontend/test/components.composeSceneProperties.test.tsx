import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, i18n } from './helpers/render';
import { useEditorStore } from '../src/store/editorStore';
import type { ComposeLayerRecord } from '../src/api/client';

const updateComposeLayer = vi.fn(() => Promise.resolve({}));
vi.mock('../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'updateComposeLayer'
          ? updateComposeLayer
          : () => Promise.resolve({}),
    }
  ),
}));
vi.mock('../src/hooks/useTrackClipRecorder', () => ({
  useTrackClipRecorder: () => ({
    canRecord: false,
    recordKeyframe: vi.fn(),
    recordKeyframes: vi.fn(),
  }),
}));

import { ComposeSceneProperties } from '../src/components/editor/ComposeLayerProperties';
import { seedEditor, testPeer } from './helpers/mesh';

const scene = {
  id: 'cs1',
  projectId: 'p1',
  rootComposeSceneId: null,
  cameraNodeId: null,
  parentId: null,
  name: 'Main Output',
  kind: 'compose_scene',
  assetId: null,
  config: {},
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
  anchorH: 'left',
  anchorV: 'top',
  sceneOrder: 0,
  cameraOrder: 0,
  visible: true,
  createdAt: '',
  updatedAt: '',
} as unknown as ComposeLayerRecord;

const tc = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'compose', ...opts });

/** The scene as the mesh holds it now. */
const cs1 = () =>
  testPeer().collection<ComposeLayerRecord>('compose_layer').get('cs1');

describe('ComposeSceneProperties — OBS window capture', () => {
  beforeEach(() => {
    updateComposeLayer.mockClear();
    seedEditor({
      composeScenes: [scene],
      assets: [],
      outputWindowStatus: null,
    });
  });

  it('shows runtime download progress and errors instead of the hint', () => {
    const enabled = { ...scene, config: { obsWindowCapture: true } };
    useEditorStore.setState({
      outputWindowStatus: { state: 'downloading', progress: 42 },
    });
    const { rerender } = renderWithProviders(
      <ComposeSceneProperties scene={enabled} />
    );
    expect(
      screen.getByText(tc('sceneProps.obsWindowDownloading', { progress: 42 }))
    ).toBeTruthy();

    useEditorStore.setState({
      outputWindowStatus: { state: 'error', message: 'offline' },
    });
    rerender(<ComposeSceneProperties scene={enabled} />);
    expect(
      screen.getByText(tc('sceneProps.obsWindowError', { message: 'offline' }))
    ).toBeTruthy();

    useEditorStore.setState({ outputWindowStatus: { state: 'ready' } });
    rerender(<ComposeSceneProperties scene={enabled} />);
    expect(
      screen.getByText(
        tc('sceneProps.obsWindowHint', { title: 'vspark – Main Output' })
      )
    ).toBeTruthy();
  });

  it('enables window capture: persists config and shows the window title to pick', () => {
    const { container } = renderWithProviders(
      <ComposeSceneProperties scene={scene} />
    );
    const box = container.querySelector(
      'input.vs-compose-obs-window'
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByText(/vspark – Main Output/)).toBeNull();

    fireEvent.click(box);

    expect(cs1()?.config.obsWindowCapture).toBe(true);
  });

  it('shows the hint with the window title while enabled, and disabling persists false', () => {
    const enabled = { ...scene, config: { obsWindowCapture: true } };
    const { container } = renderWithProviders(
      <ComposeSceneProperties scene={enabled} />
    );
    expect(
      screen.getByText(
        tc('sceneProps.obsWindowHint', { title: 'vspark – Main Output' })
      )
    ).toBeTruthy();

    fireEvent.click(
      container.querySelector('input.vs-compose-obs-window') as HTMLInputElement
    );

    expect(cs1()?.config.obsWindowCapture).toBe(false);
  });
});
