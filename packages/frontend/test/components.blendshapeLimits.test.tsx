/**
 * components.blendshapeLimits.test.tsx
 *
 * The Expression Limits behavior panel: it renders the shipped rule set, edits
 * write through to the store, and the raw-JSON escape hatch round-trips (and
 * refuses to apply malformed input).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, i18n } from './helpers/render';
import { useEditorStore, type Behavior } from '../src/store/editorStore';
import { defaultBlendshapeLimits } from '@vspark/shared/blendshapeLimits';

vi.mock('../src/api/client', () => ({
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

const tp = (key: string) => i18n.t(key, { ns: 'properties' });

/** The Raw JSON section ships collapsed — open it before reaching for the textarea. */
const openJsonSection = () =>
  fireEvent.click(screen.getByText(tp('blendshapeLimits.jsonHeader')));

const behavior = (config: Record<string, unknown>): Behavior =>
  ({
    id: 'beh-1',
    nodeId: 'avatar-1',
    kind: 'blendshape_limiter',
    enabled: true,
    config,
  }) as Behavior;

function seed(config: Record<string, unknown>) {
  useEditorStore.setState({
    nodes: [
      {
        id: 'avatar-1',
        rootSceneNodeId: 'scene-1',
        projectId: 'proj-1',
        parentId: null,
        name: 'Avatar',
        kind: 'avatar',
        components: {},
      },
    ],
    // The focused behavior panel renders when a behavior is selected without a
    // node selection — that's the path the Behaviors tab puts you on.
    selectedNodeId: null,
    selectedBehaviorId: 'beh-1',
    behaviors: [behavior(config)],
    behaviorKinds: [
      {
        kind: 'blendshape_limiter',
        label: 'Expression Limits',
        icon: '🚦',
        description: 'Keeps expressions from stacking into broken faces.',
        applicableTo: ['avatar'],
        defaultConfig: {},
      },
    ],
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

/** Current limits config as the store holds it. */
const storedLimits = () =>
  (
    useEditorStore.getState().behaviors[0].config as {
      limits: ReturnType<typeof defaultBlendshapeLimits>;
    }
  ).limits;

beforeEach(() => {
  seed({ limits: defaultBlendshapeLimits() });
});

describe('Expression Limits panel', () => {
  it('renders the shipped groups and clamp rules', () => {
    renderWithProviders(<PropertiesPanel />);

    expect(screen.getByText(tp('blendshapeLimits.enabled'))).toBeTruthy();
    // Section headers carry a count of the rules they hold.
    expect(
      screen.getByText(`${tp('blendshapeLimits.groupsHeader')} (1)`)
    ).toBeTruthy();
    expect(
      screen.getByText(`${tp('blendshapeLimits.clampsHeader')} (2)`)
    ).toBeTruthy();
    // The default rules are editable by label.
    expect(screen.getByDisplayValue('Joy limits eye close')).toBeTruthy();
    expect(screen.getByDisplayValue('Joy limits mouth open')).toBeTruthy();
    // Pattern chips render the names the rules match on.
    expect(screen.getAllByText('Fcl_ALL_Joy').length).toBeGreaterThan(0);
  });

  it('toggling the master switch writes through to the store', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    const toggle = container.querySelector(
      '.vs-bslimits-enabled'
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(storedLimits().enabled).toBe(false);
  });

  it('renaming a clamp rule writes through to the store', () => {
    renderWithProviders(<PropertiesPanel />);
    const input = screen.getByDisplayValue(
      'Joy limits mouth open'
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Mouth cap' } });

    expect(storedLimits().clamps?.map((c) => c.label)).toContain('Mouth cap');
  });

  it('removing a group drops it from the config', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      container.querySelector('.vs-bslimits-group-remove') as HTMLElement
    );
    expect(storedLimits().groups).toHaveLength(0);
  });

  it('adding a clamp rule appends one', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      container.querySelector('.vs-bslimits-add-clamp') as HTMLElement
    );
    expect(storedLimits().clamps).toHaveLength(3);
  });

  it('adding a name to a member appends a pattern', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    const add = container.querySelector(
      '.vs-bslimits-name-add'
    ) as HTMLInputElement;
    fireEvent.change(add, { target: { value: 'Fcl_ALL_Grin' } });
    fireEvent.keyDown(add, { key: 'Enter' });

    expect(storedLimits().groups?.[0].members[0].patterns).toContain(
      'Fcl_ALL_Grin'
    );
  });

  it('resetting restores the shipped defaults', () => {
    seed({ limits: { enabled: true, groups: [], clamps: [] } });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      container.querySelector('.vs-bslimits-reset') as HTMLElement
    );

    expect(storedLimits().groups).toHaveLength(1);
    expect(storedLimits().clamps).toHaveLength(2);
  });

  it('applies an edited raw JSON document', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    openJsonSection();
    const textarea = container.querySelector(
      '.vs-bslimits-json'
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain('"groups"');

    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          enabled: true,
          groups: [],
          clamps: [{ id: 'only', targets: ['aa'], max: 0.2 }],
        }),
      },
    });
    fireEvent.click(
      container.querySelector('.vs-bslimits-json-apply') as HTMLElement
    );

    expect(storedLimits().groups).toHaveLength(0);
    expect(storedLimits().clamps?.[0].id).toBe('only');
  });

  it('surfaces a parse error instead of writing malformed JSON', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    const before = JSON.stringify(storedLimits());
    openJsonSection();
    const textarea = container.querySelector(
      '.vs-bslimits-json'
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '{ not json' } });
    fireEvent.click(
      container.querySelector('.vs-bslimits-json-apply') as HTMLElement
    );

    expect(JSON.stringify(storedLimits())).toBe(before);
    // The apply button stays enabled with the draft intact so the user can fix it.
    expect(
      (container.querySelector('.vs-bslimits-json') as HTMLTextAreaElement)
        .value
    ).toBe('{ not json');
  });

  it('discarding a JSON draft restores the stored document', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    openJsonSection();
    const textarea = container.querySelector(
      '.vs-bslimits-json'
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{}' } });
    fireEvent.click(
      container.querySelector('.vs-bslimits-json-revert') as HTMLElement
    );

    expect(
      (container.querySelector('.vs-bslimits-json') as HTMLTextAreaElement)
        .value
    ).toContain('"clamps"');
  });
});
