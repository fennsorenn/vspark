import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, i18n } from './helpers/render';
import { useEditorStore, type StageObject } from '../src/store/editorStore';

// PropertiesPanel pulls in network + media + 3D-adjacent modules; stub the ones
// that aren't relevant to rendering a plain node's inspector.
vi.mock('../src/api/client', () => ({
  // any api.* call resolves to a no-op promise
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
  fireSignalEvent: vi.fn(),
  updateScene: vi.fn(),
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
  ComposeLayerProperties: ({ layer }: { layer: { id: string } }) => (
    <div data-testid="compose-layer-props">{layer.id}</div>
  ),
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

const tp = (key: string) => i18n.t(key, { ns: 'properties' });

const makeNode = (over: Partial<StageObject> = {}): StageObject => ({
  id: 'node-1',
  rootSceneNodeId: 'scene-1',
  projectId: 'proj-1',
  parentId: null,
  name: 'My Group',
  kind: 'group',
  components: {},
  ...over,
});

/** Reset only the store slices the panel reads, preserving the action fns. */
function seed(partial: Record<string, unknown>) {
  useEditorStore.setState({
    nodes: [],
    selectedNodeId: null,
    selectedEffect: null,
    selectedComposeLayerId: null,
    sceneSelected: false,
    scenes: [],
    behaviors: [],
    cameraEffects: [],
    composeLayers: [],
    assets: [],
    leftTab: 'scene',
    activeLogicId: null,
    ...partial,
  });
}

beforeEach(() => {
  seed({});
});

describe('PropertiesPanel — selection branches', () => {
  it('shows the graphs-tab empty state when the graphs tab is active', () => {
    seed({ leftTab: 'graphs', activeLogicId: null });
    renderWithProviders(<PropertiesPanel />);
    expect(screen.getByText(tp('emptyState.graphsTabNoGraph'))).toBeTruthy();
  });

  it('delegates to ComposeLayerProperties for a selected compose layer', () => {
    seed({
      leftTab: 'compose',
      selectedComposeLayerId: 'layer-9',
      composeLayers: [{ id: 'layer-9', name: 'L', kind: 'image' }],
    });
    renderWithProviders(<PropertiesPanel />);
    expect(screen.getByTestId('compose-layer-props').textContent).toBe('layer-9');
  });
});

describe('PropertiesPanel — node inspector', () => {
  it('renders the selected node name + transform controls', () => {
    const node = makeNode({ name: 'Hero Rig' });
    seed({ nodes: [node], selectedNodeId: node.id });
    renderWithProviders(<PropertiesPanel />);

    // Name field reflects the node.
    expect((screen.getByDisplayValue('Hero Rig') as HTMLInputElement).value).toBe(
      'Hero Rig'
    );
    // Transform group labels render (i18n-resolved, so locale-proof).
    expect(screen.getByText(tp('transform.position'))).toBeTruthy();
    expect(screen.getByText(tp('transform.rotation'))).toBeTruthy();
    expect(screen.getByText(tp('transform.scale'))).toBeTruthy();
  });

  it('editing the name and blurring writes through to the store', () => {
    const node = makeNode({ name: 'Old Name' });
    seed({ nodes: [node], selectedNodeId: node.id });
    renderWithProviders(<PropertiesPanel />);

    const input = screen.getByDisplayValue('Old Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.blur(input);

    expect(useEditorStore.getState().nodes[0].name).toBe('New Name');
  });
});
