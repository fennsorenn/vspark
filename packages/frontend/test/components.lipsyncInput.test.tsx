/**
 * components.lipsyncInput.test.tsx
 *
 * The Lipsync behavior's audio input in the Properties panel: the PipeWire
 * option is offered only when the server says it can capture
 * (`server_status` doc `capabilities:main`), a behavior already set to it
 * keeps it with a warning, and the capture's state (the behavior's
 * `tracking:<id>` status doc) is shown below the source.
 */

import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, i18n } from './helpers/render';
import { type Behavior } from '../src/store/editorStore';

vi.mock('../src/api/client', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
  fireSignalEvent: vi.fn(),
  updateScene: vi.fn(),
  getBehaviorTemplate: vi.fn(() => new Promise(() => {})),
}));
vi.mock('../src/media/MicCapture', () => ({ MicCapture: class {} }));
vi.mock('../src/hooks/useTrackClipRecorder', () => ({
  useTrackClipRecorder: () => ({
    canRecord: false,
    recordKeyframe: vi.fn(),
    recordKeyframes: vi.fn(),
  }),
}));
vi.mock('../src/components/editor/ComposeLayerProperties', () => ({
  ComposeLayerProperties: () => null,
  ComposeSceneProperties: () => null,
}));
vi.mock('../src/vrmRegistry', () => ({
  vrmRegistry: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../src/components/editor/materialOverrides', () => ({
  getMaterialSlots: () => [],
}));
vi.mock('../src/particleTextures', () => ({
  getBuiltinParticleTextures: () => [],
  builtinParticleTextureUrl: () => '',
}));

import { PropertiesPanel } from '../src/components/editor/PropertiesPanel';
import { seedEditor, testPeer } from './helpers/mesh';

const tp = (key: string) => i18n.t(key, { ns: 'properties' });

let clock = 0;
function putStatus(doc: Record<string, unknown> & { id: string }) {
  testPeer()
    .collection<{ id: string }>('server_status')
    .put(doc, { v: { t: ++clock, c: 0, n: 'seed' } });
}

function seed(config: Record<string, unknown>) {
  seedEditor({
    nodes: [
      {
        id: 'avatar-1',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Avatar',
        kind: 'avatar',
        components: {},
        properties: {},
      },
    ],
    projectId: 'proj-1',
    selectedNodeId: 'avatar-1',
    selectedBehaviorId: 'ls1',
    behaviors: [
      {
        id: 'ls1',
        nodeId: 'avatar-1',
        kind: 'lipsync_processor',
        enabled: true,
        config,
      } as Behavior,
    ],
    behaviorKinds: [
      {
        kind: 'lipsync_processor',
        label: 'Lipsync',
        icon: '',
        description: '',
        applicableTo: ['avatar'],
        defaultConfig: {},
      },
    ],
    vrmExpressionsByNode: {},
    vrmMorphTargetsByNode: {},
    selectedEffect: null,
    selectedComposeLayerId: null,
    sceneSelected: false,
    scenes: [],
    cameraEffects: [],
    composeLayers: [],
    assets: [],
    leftTab: 'scene',
    activeLogicId: null,
  } as never);
}

const capability = (pipewireLipsync: boolean) =>
  putStatus({
    id: 'capabilities:main',
    kind: 'capabilities',
    key: 'main',
    of: null,
    pipewireLipsync,
  });

const optionValues = () =>
  [
    ...document.querySelectorAll<HTMLOptionElement>(
      '.vs-lipsync-input-mode option'
    ),
  ].map((o) => o.value);

describe('Lipsync audio input', () => {
  it('offers PipeWire only when the server can capture', () => {
    seed({ inputMode: 'browser' });
    capability(false);
    const r = renderWithProviders(<PropertiesPanel />);
    expect(optionValues()).toEqual(['browser']);
    r.unmount();

    capability(true);
    renderWithProviders(<PropertiesPanel />);
    expect(optionValues()).toEqual(['browser', 'pipewire']);
  });

  it('keeps PipeWire selected on a server that cannot capture, with a warning', () => {
    seed({ inputMode: 'pipewire', pipewireSource: 'vmic.monitor' });
    capability(false);
    renderWithProviders(<PropertiesPanel />);
    expect(optionValues()).toEqual(['browser', 'pipewire']);
    expect(
      document.querySelector('.vs-lipsync-capture-status')!.textContent
    ).toBe(tp('lipsync.pipewireUnavailable'));
  });

  it('asks for a source before there is one', () => {
    seed({ inputMode: 'pipewire', pipewireSource: '' });
    capability(true);
    renderWithProviders(<PropertiesPanel />);
    expect(
      document.querySelector('.vs-lipsync-capture-status')!.textContent
    ).toBe(tp('lipsync.noSource'));
  });

  it("shows the capture state and parec's message", () => {
    seed({ inputMode: 'pipewire', pipewireSource: 'nope.monitor' });
    capability(true);
    putStatus({
      id: 'tracking:ls1',
      kind: 'tracking',
      key: 'ls1',
      of: { rtype: 'behavior', id: 'ls1' },
      connected: false,
      capture: { state: 'error', message: 'Stream error: No such entity' },
    });
    renderWithProviders(<PropertiesPanel />);
    const status = document.querySelector('.vs-lipsync-capture-status')!;
    expect(status.textContent).toContain(tp('lipsync.captureState.error'));
    expect(status.textContent).toContain('Stream error: No such entity');
    expect(screen.queryByText(/Open Media Input/)).toBeNull();
  });
});
