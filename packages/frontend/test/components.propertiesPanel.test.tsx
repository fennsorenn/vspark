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
    expect(screen.getByTestId('compose-layer-props').textContent).toBe(
      'layer-9'
    );
  });
});

describe('PropertiesPanel — node inspector', () => {
  it('renders the selected node name + transform controls', () => {
    const node = makeNode({ name: 'Hero Rig' });
    seed({ nodes: [node], selectedNodeId: node.id });
    renderWithProviders(<PropertiesPanel />);

    // Name field reflects the node.
    expect(
      (screen.getByDisplayValue('Hero Rig') as HTMLInputElement).value
    ).toBe('Hero Rig');
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

// ---------------------------------------------------------------------------
// Stylized Tracking (pose_stylizer) behavior panel
// ---------------------------------------------------------------------------

const STYLIZER_KIND = {
  kind: 'pose_stylizer',
  label: 'Stylized Tracking',
  icon: '🎭',
  description: 'Stylizes tracking.',
  applicableTo: ['avatar'],
  defaultConfig: {},
};

/** Select a pose_stylizer behavior so PropertiesPanel renders its panel. */
function seedStylizer(config: Record<string, unknown> = {}) {
  seed({
    behaviors: [
      {
        id: 'beh-1',
        nodeId: 'node-1',
        kind: 'pose_stylizer',
        enabled: true,
        config,
      },
    ],
    behaviorKinds: [STYLIZER_KIND],
    selectedBehaviorId: 'beh-1',
  });
}

const cfgOf = () =>
  (useEditorStore.getState().behaviors[0].config ?? {}) as Record<
    string,
    unknown
  >;

describe('PropertiesPanel — Stylized Tracking behavior', () => {
  it('renders the headline controls and both collapsible sections', () => {
    seedStylizer();
    renderWithProviders(<PropertiesPanel />);

    expect(screen.getByText(tp('stylizedTracking.amount'))).toBeTruthy();
    expect(screen.getByText(tp('stylizedTracking.strength'))).toBeTruthy();
    expect(screen.getByText(tp('stylizedTracking.lag'))).toBeTruthy();
    expect(screen.getByText(tp('stylizedTracking.restUnmapped'))).toBeTruthy();
    expect(
      screen.getByText(tp('stylizedTracking.responseSection'))
    ).toBeTruthy();
    // The rig section header carries the bone count.
    expect(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    ).toBeTruthy();
  });

  it('defaults amount to fully stylized and follow-through to 0.08s', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    const amount = container.querySelector(
      '.vs-stylize-amount input[type="range"]'
    ) as HTMLInputElement;
    expect(amount.value).toBe('1');
    const lag = container.querySelector(
      '.vs-stylize-lag input'
    ) as HTMLInputElement;
    expect(lag.value).toBe('0.08');
  });

  it('writes the amount dial through to the behavior config', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    const amount = container.querySelector(
      '.vs-stylize-amount input[type="range"]'
    ) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '0.4' } });
    expect(cfgOf().amount).toBeCloseTo(0.4, 6);
  });

  it('toggles restUnmapped', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    const box = container.querySelector(
      '.vs-stylize-rest-unmapped'
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(cfgOf().restUnmapped).toBe(true);
  });

  it('shows response knobs seeded from the shared defaults and writes edits back', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(screen.getByText(tp('stylizedTracking.responseSection')));

    const maxRate = container.querySelector(
      '.vs-stylize-response-maxRate input'
    ) as HTMLInputElement;
    expect(maxRate.value).toBe('5'); // DEFAULT_STYLE_RESPONSE.maxRate

    fireEvent.change(maxRate, { target: { value: '2' } });
    expect((cfgOf().response as Record<string, unknown>).maxRate).toBe(2);
  });

  it('lists the stock rig bones and reveals a bone’s drivers when expanded', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );

    const headRow = container.querySelector('.vs-stylize-bone-head');
    expect(headRow).toBeTruthy();
    // Drivers are hidden until the row is expanded.
    expect(container.querySelector('.vs-stylize-drv-head-headYaw')).toBeNull();

    fireEvent.click(headRow!);
    expect(
      container.querySelector('.vs-stylize-drv-head-headYaw')
    ).toBeTruthy();
  });

  it('stores ONLY the edited bone as an override, seeded from the stock entry', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    fireEvent.click(container.querySelector('.vs-stylize-bone-head')!);

    // X / Y / Z — Y is the yaw column.
    const yaw = container.querySelectorAll(
      '.vs-stylize-drv-head-headYaw input'
    )[1] as HTMLInputElement;
    expect(yaw.value).toBe('20'); // DEFAULT_STYLE_RIG.head.drivers.headYaw[1]

    fireEvent.change(yaw, { target: { value: '35' } });

    const rig = cfgOf().rig as Record<
      string,
      { mode?: string; drivers?: Record<string, number[]> }
    >;
    expect(Object.keys(rig)).toEqual(['head']); // only the edited bone is stored
    expect(rig.head.drivers!.headYaw).toEqual([0, 35, 0]);
    // The rest of the stock entry came along, so the override is self-contained.
    expect(rig.head.mode).toBe('replace');
    expect(rig.head.drivers!.headPitch).toEqual([22, 0, 0]);
  });

  it('reset-rig clears every override back to stock', () => {
    seedStylizer({
      rig: {
        head: { mode: 'replace', lag: 0.2, drivers: { headYaw: [0, 35, 0] } },
      },
    });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    fireEvent.click(container.querySelector('.vs-stylize-reset-rig')!);
    expect(cfgOf().rig).toBeNull();
  });
});

describe('PropertiesPanel — Stylized Tracking rig presets', () => {
  const openRig = (container: HTMLElement) =>
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    ) && container;

  const headYawField = (container: HTMLElement) => {
    fireEvent.click(container.querySelector('.vs-stylize-bone-head')!);
    return container.querySelectorAll(
      '.vs-stylize-drv-head-headYaw input'
    )[1] as HTMLInputElement;
  };

  it('offers the full preset selection and defaults to follow', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    const sel = container.querySelector(
      '.vs-stylize-preset'
    ) as HTMLSelectElement;
    expect(sel.value).toBe('follow');
    expect([...sel.options].map((o) => o.value)).toEqual([
      'follow',
      'counter',
      'headOnly',
      'headOnlyCounter',
      'expressive',
    ]);
    // Every option is translated, not a raw key.
    for (const o of [...sel.options]) expect(o.textContent).not.toContain('.');
  });

  it('writes the chosen preset to the behavior config', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.change(container.querySelector('.vs-stylize-preset')!, {
      target: { value: 'counter' },
    });
    expect(cfgOf().preset).toBe('counter');
  });

  it('re-baselines the rig editor on the selected preset', () => {
    // follow: the head carries 20° of yaw; counter cranks it to 38° because the
    // torso is subtracting instead of adding.
    seedStylizer({ preset: 'follow' });
    const a = renderWithProviders(<PropertiesPanel />);
    openRig(a.container);
    expect(headYawField(a.container).value).toBe('20');
    a.unmount();

    seedStylizer({ preset: 'counter' });
    const b = renderWithProviders(<PropertiesPanel />);
    openRig(b.container);
    expect(headYawField(b.container).value).toBe('38');
  });

  it('shows the torso countering the head under the counter preset', () => {
    seedStylizer({ preset: 'counter' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    openRig(container);
    fireEvent.click(container.querySelector('.vs-stylize-bone-hips')!);
    const hipsYaw = container.querySelectorAll(
      '.vs-stylize-drv-hips-headYaw input'
    )[1] as HTMLInputElement;
    expect(parseFloat(hipsYaw.value)).toBeLessThan(0);
  });

  it('seeds an override from the SELECTED preset when a bone is edited', () => {
    seedStylizer({ preset: 'counter' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    openRig(container);
    const yaw = headYawField(container);
    fireEvent.change(yaw, { target: { value: '42' } });

    const rig = cfgOf().rig as Record<
      string,
      { drivers?: Record<string, number[]> }
    >;
    expect(rig.head.drivers!.headYaw).toEqual([0, 42, 0]);
    // The untouched drivers came from counter (37), not follow (22).
    expect(rig.head.drivers!.headPitch).toEqual([37, 0, 0]);
  });
});

describe('PropertiesPanel — presets that reach past the rig', () => {
  const openResponse = () =>
    fireEvent.click(screen.getByText(tp('stylizedTracking.responseSection')));

  it('headOnly drops the body-driven bones from the rig editor', () => {
    seedStylizer({ preset: 'headOnly' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    // The forearms exist only for body follow-through, so headOnly loses them.
    expect(container.querySelector('.vs-stylize-bone-leftLowerArm')).toBeNull();
    expect(container.querySelector('.vs-stylize-bone-chest')).toBeTruthy();
  });

  it('shows only head drivers on a headOnly bone', () => {
    seedStylizer({ preset: 'headOnly' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    fireEvent.click(container.querySelector('.vs-stylize-bone-chest')!);
    expect(
      container.querySelector('.vs-stylize-drv-chest-headYaw')
    ).toBeTruthy();
    expect(container.querySelector('.vs-stylize-drv-chest-bodyYaw')).toBeNull();
  });

  it('expressive re-baselines the response fields from its own preset values', () => {
    seedStylizer({ preset: 'follow' });
    const a = renderWithProviders(<PropertiesPanel />);
    openResponse();
    expect(
      (
        a.container.querySelector(
          '.vs-stylize-response-headRange input'
        ) as HTMLInputElement
      ).value
    ).toBe('45');
    a.unmount();

    seedStylizer({ preset: 'expressive' });
    const b = renderWithProviders(<PropertiesPanel />);
    openResponse();
    expect(
      (
        b.container.querySelector(
          '.vs-stylize-response-headRange input'
        ) as HTMLInputElement
      ).value
    ).toBe('30');
  });

  it('expressive re-baselines follow-through too', () => {
    seedStylizer({ preset: 'expressive' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    const lag = container.querySelector(
      '.vs-stylize-lag input'
    ) as HTMLInputElement;
    expect(lag.value).toBe('0.12');
  });

  it('a user response edit still wins over the preset baseline', () => {
    seedStylizer({ preset: 'expressive', response: { headRange: 60 } });
    const { container } = renderWithProviders(<PropertiesPanel />);
    openResponse();
    expect(
      (
        container.querySelector(
          '.vs-stylize-response-headRange input'
        ) as HTMLInputElement
      ).value
    ).toBe('60');
    // …and an untouched field still comes from the preset.
    expect(
      (
        container.querySelector(
          '.vs-stylize-response-bodyRange input'
        ) as HTMLInputElement
      ).value
    ).toBe('18');
  });

  it('reset response clears both the response override and the lag override', () => {
    seedStylizer({
      preset: 'expressive',
      response: { headRange: 60 },
      lag: 0.4,
    });
    const { container } = renderWithProviders(<PropertiesPanel />);
    openResponse();
    fireEvent.click(container.querySelector('.vs-stylize-reset-response')!);
    expect(cfgOf().response).toEqual({});
    expect(cfgOf().lag).toBeNull();
  });
});

describe('PropertiesPanel — Stylized Tracking strength', () => {
  const slider = (container: HTMLElement, cls: string) =>
    container.querySelector(`${cls} input[type="range"]`) as HTMLInputElement;

  it('defaults to the neutral 1× and offers a 0–2 range', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    const s = slider(container, '.vs-stylize-strength');
    expect(s.value).toBe('1');
    expect(s.min).toBe('0');
    expect(s.max).toBe('2');
  });

  it('writes the multiplier through to the behavior config', () => {
    seedStylizer();
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.change(slider(container, '.vs-stylize-strength'), {
      target: { value: '1.6' },
    });
    expect(cfgOf().strength).toBeCloseTo(1.6, 6);
  });

  it('is a separate control from the blend dial', () => {
    seedStylizer({ amount: 0.4, strength: 1.5 });
    const { container } = renderWithProviders(<PropertiesPanel />);
    expect(slider(container, '.vs-stylize-amount').value).toBe('0.4');
    expect(slider(container, '.vs-stylize-strength').value).toBe('1.5');
    // Editing one leaves the other alone.
    fireEvent.change(slider(container, '.vs-stylize-strength'), {
      target: { value: '2' },
    });
    expect(cfgOf().amount).toBe(0.4);
    expect(cfgOf().strength).toBe(2);
  });

  it('labels the pair distinguishably (blend vs multiplier)', () => {
    expect(tp('stylizedTracking.amount')).not.toBe(
      tp('stylizedTracking.strength')
    );
  });
});

describe('PropertiesPanel — contrapposto head-only preset', () => {
  it('re-baselines the rig editor on headOnlyCounter', () => {
    seedStylizer({ preset: 'headOnlyCounter' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    fireEvent.click(container.querySelector('.vs-stylize-bone-chest')!);
    // Torso counters the head turn → negative yaw.
    const chestYaw = container.querySelectorAll(
      '.vs-stylize-drv-chest-headYaw input'
    )[1] as HTMLInputElement;
    expect(parseFloat(chestYaw.value)).toBeLessThan(0);
    // …and it stays head-only: no body drivers offered on the bone.
    expect(container.querySelector('.vs-stylize-drv-chest-bodyYaw')).toBeNull();
  });

  it('shows the nod weaker on the torso than the turn', () => {
    seedStylizer({ preset: 'headOnlyCounter' });
    const { container } = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(
      screen.getByText(
        new RegExp(`^${tp('stylizedTracking.rigSection')} \\(\\d+\\)$`)
      )
    );
    fireEvent.click(container.querySelector('.vs-stylize-bone-chest')!);
    const nodX = parseFloat(
      (
        container.querySelectorAll(
          '.vs-stylize-drv-chest-headPitch input'
        )[0] as HTMLInputElement
      ).value
    );
    const turnY = parseFloat(
      (
        container.querySelectorAll(
          '.vs-stylize-drv-chest-headYaw input'
        )[1] as HTMLInputElement
      ).value
    );
    expect(Math.abs(nodX)).toBeLessThan(Math.abs(turnY));
  });
});
