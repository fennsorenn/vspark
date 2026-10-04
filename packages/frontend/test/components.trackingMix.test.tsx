/**
 * components.trackingMix.test.tsx
 *
 * The Tracking Mix: source listing / face grouping (pure helpers), the sidebar
 * master sliders, and the mixer modal's region → bone editing, "Custom" state,
 * reset rule and source order — all asserted on the avatar node's stored
 * `properties.trackingMix`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent, i18n } from './helpers/render';
import { type Behavior } from '../src/store/editorStore';

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
import {
  buildFaceGroups,
  buildMixSources,
} from '../src/components/editor/TrackingMix';
import { docsOf, seedEditor } from './helpers/mesh';

const tp = (key: string, opts?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'properties', ...opts });

const beh = (id: string, kind: string): Behavior =>
  ({ id, nodeId: 'avatar-1', kind, enabled: true, config: {} }) as Behavior;

function seed(
  trackingMix?: Record<string, unknown>,
  behaviors: Behavior[] = [beh('vmc', 'vmc_receiver'), beh('br', 'breathing')]
) {
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
        properties: trackingMix ? { trackingMix } : {},
      },
    ],
    projectId: 'proj-1',
    selectedNodeId: 'avatar-1',
    selectedBehaviorId: null,
    behaviors,
    behaviorKinds: [
      {
        kind: 'vmc_receiver',
        label: 'VMC Receiver',
        icon: '',
        description: '',
        applicableTo: ['avatar'],
        defaultConfig: {},
      },
      {
        kind: 'breathing',
        label: 'Breathing',
        icon: '',
        description: '',
        applicableTo: ['avatar'],
        defaultConfig: {},
      },
      {
        kind: 'lipsync_processor',
        label: 'Lip Sync',
        icon: '',
        description: '',
        applicableTo: ['avatar'],
        defaultConfig: {},
      },
    ],
    vrmExpressionsByNode: { 'avatar-1': ['aa', 'blink', 'happy'] },
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

const storedMix = () =>
  (docsOf<{ id: string; properties?: Record<string, unknown> }>(
    'scene_node'
  ).find((n) => n.id === 'avatar-1')!.properties?.trackingMix ?? {}) as {
    order?: string[];
    sources?: Record<
      string,
      { bones?: Record<string, number>; blendshapes?: Record<string, number> }
    >;
  };

/** Drive a SliderInput: change + pointer-up commits. */
function slide(container: Element, value: number) {
  const range = container.querySelector(
    'input[type="range"]'
  ) as HTMLInputElement;
  fireEvent.change(range, { target: { value: String(value) } });
  // The commit reads the DOM value; a controlled re-render may already have
  // put the old value back, so release at the dragged-to value explicitly.
  fireEvent.pointerUp(range, { target: { value: String(value) } });
}

describe('buildMixSources', () => {
  const label = (k: string) => k.toUpperCase();
  it('lists animation first, then bone/shape sources by legacy priority', () => {
    const s = buildMixSources(
      [
        beh('br', 'breathing'),
        beh('v1', 'vmc_receiver'),
        beh('x', 'pose_stylizer'),
        beh('lip', 'lipsync_processor'),
      ],
      label,
      'Anim',
      undefined
    );
    expect(s.map((x) => x.id)).toEqual(['animation', 'v1', 'lip', 'br']);
    expect(s.find((x) => x.id === 'lip')).toMatchObject({
      bones: false,
      blendshapes: true,
    });
    expect(s.find((x) => x.id === 'br')).toMatchObject({
      bones: true,
      blendshapes: false,
    });
  });
  it('honours mix.order and numbers repeated kinds', () => {
    const s = buildMixSources(
      [beh('a', 'vmc_receiver'), beh('b', 'vmc_receiver')],
      label,
      'Anim',
      { order: ['b', 'a'] }
    );
    expect(s.map((x) => x.id)).toEqual(['animation', 'b', 'a']);
    expect(s[1].label).toBe('VMC_RECEIVER 2');
  });
});

describe('buildFaceGroups', () => {
  it('groups model shapes and keeps shapes the mix already weights', () => {
    const g = buildFaceGroups(['Fcl_MTH_A', 'blink', 'happy'], {
      sources: { x: { blendshapes: { Fcl_BRW_Up: 0.5 } } },
    });
    expect(g.map((x) => x.group)).toEqual([
      'mouth',
      'eyes',
      'brows',
      'emotions',
    ]);
    expect(g.find((x) => x.group === 'brows')!.shapes).toEqual(['Fcl_BRW_Up']);
  });
});

describe('Tracking Mix sidebar', () => {
  beforeEach(() => seed());

  it('shows one master slider per source', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    expect(container.textContent).toContain(tp('trackingMix.header'));
    expect(container.querySelectorAll('.vs-mix-master')).toHaveLength(3);
  });

  it('a master slider writes the source weight to every bone', () => {
    const { container } = renderWithProviders(<PropertiesPanel />);
    const masters = container.querySelectorAll('.vs-mix-master');
    slide(masters[1], 0.5); // VMC
    const bones = storedMix().sources!.vmc.bones!;
    expect(bones.head).toBe(0.5);
    expect(bones.leftLittleDistal).toBe(0.5);
    expect(Object.keys(bones)).toHaveLength(55);
  });

  it('shows Custom when a source differs across bones, reset uses the most common value', () => {
    seed({ sources: { vmc: { bones: { head: 0.3 } } } });
    const { container } = renderWithProviders(<PropertiesPanel />);
    expect(screen.getAllByText(tp('trackingMix.custom')).length).toBe(1);
    fireEvent.click(container.querySelector('.vs-mix-master-reset')!);
    // 54 bones at 1 vs one at 0.3 → 1 everywhere, pruned away.
    expect(storedMix().sources?.vmc).toBeUndefined();
  });
});

describe('Tracking Mix modal', () => {
  beforeEach(() => seed());

  const open = () => {
    const r = renderWithProviders(<PropertiesPanel />);
    fireEvent.click(r.container.querySelector('.vs-mix-open')!);
    return r;
  };

  it('a region cell sets all its bones; editing one bone turns the region Custom', () => {
    open();
    const dialog = screen.getByRole('dialog');
    // Columns: Animation, VMC, Breathing. Rows start with Head.
    const headCells = dialog.querySelectorAll('.vs-mix-group-cell');
    slide(headCells[1], 0.4); // Head × VMC
    expect(storedMix().sources!.vmc.bones).toEqual({
      neck: 0.4,
      head: 0.4,
      jaw: 0.4,
    });

    fireEvent.click(dialog.querySelectorAll('.vs-mix-expand')[0]); // expand Head
    const boneCells = dialog.querySelectorAll('.vs-mix-member-cell');
    // Head's bones × 3 columns; second row (head) × VMC column.
    slide(boneCells[3 + 1], 0.9);
    expect(storedMix().sources!.vmc.bones!.head).toBe(0.9);
    expect(dialog.querySelector('.vs-mix-group-reset')).toBeTruthy();
    expect(dialog.textContent).toContain(tp('trackingMix.custom'));
    // The sidebar master for VMC is mixed now too.
    expect(screen.getAllByText(tp('trackingMix.custom'))).toHaveLength(2);

    // Reset → most frequent (0.4, two bones) on every Head bone.
    fireEvent.click(dialog.querySelector('.vs-mix-group-reset')!);
    expect(storedMix().sources!.vmc.bones).toEqual({
      neck: 0.4,
      head: 0.4,
      jaw: 0.4,
    });
  });

  it('the order arrows reorder tracking sources', () => {
    open();
    const dialog = screen.getByRole('dialog');
    // Default order: VMC (priority 0), Breathing (10). Move Breathing earlier.
    fireEvent.click(dialog.querySelectorAll('.vs-mix-order-up')[1]);
    expect(storedMix().order).toEqual(['br', 'vmc']);
  });

  it('the Face tab lists the model expressions for blendshape sources', () => {
    open();
    fireEvent.click(document.querySelector('.vs-mix-tab-face')!);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(tp('trackingMix.faceGroup.mouth'));
    // VMC is the only face source here (Breathing sends no expressions).
    const cells = dialog.querySelectorAll('.vs-mix-group-cell');
    expect(cells).toHaveLength(3); // mouth, eyes, emotions × 1 source
    slide(cells[0], 0);
    expect(storedMix().sources!.vmc.blendshapes).toEqual({ aa: 0 });
  });

  it('closes on the close button', () => {
    open();
    fireEvent.click(document.querySelector('.vs-mix-close')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
